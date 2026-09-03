import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { InviteTokenEntity } from '../../src/modules/identity/infrastructure/entities/invite-token.entity';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { OutboxPollerService } from '../../src/modules/notifications/application/outbox-poller.service';
import { EmailMessage } from '../../src/modules/notifications/domain/email-message';
import { NotificationSender } from '../../src/modules/notifications/domain/notification-sender.port';
import { NOTIFICATION_SENDER } from '../../src/modules/notifications/infrastructure/notification-sender.token';
import {
  PaymentInitializeParams,
  PaymentInitializeResult,
  PaymentProvider,
  PaymentRefundResult,
  PaymentVerificationResult,
  PaymentWebhookEvent,
} from '../../src/modules/payments/domain/ports/payment-provider.port';
import { PaymentIntentEntity } from '../../src/modules/payments/infrastructure/entities/payment-intent.entity';
import { PricingRuleEntity } from '../../src/modules/payments/infrastructure/entities/pricing-rule.entity';
import { PaystackPaymentProvider } from '../../src/modules/payments/infrastructure/paystack-payment-provider';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

interface SuccessListBody {
  success: true;
  data: { items: Record<string, unknown>[] };
}

class FakeNotificationSender implements NotificationSender {
  sentMessages: EmailMessage[] = [];

  sendEmail(message: EmailMessage): Promise<void> {
    this.sentMessages.push(message);
    return Promise.resolve();
  }
}

// Same fake as payments.e2e-spec.ts — initialize() always succeeds, no real
// network call, so dispatch/create-intent tests can run without a real
// Paystack account.
class FakePaystackPaymentProvider implements PaymentProvider {
  initialize(
    params: PaymentInitializeParams,
  ): Promise<PaymentInitializeResult> {
    return Promise.resolve({
      authorizationUrl: `https://fake.paystack.test/pay/${params.reference}`,
      providerReference: params.reference,
    });
  }

  verify(): Promise<PaymentVerificationResult> {
    throw new Error('not used by this suite');
  }

  refund(): Promise<PaymentRefundResult> {
    throw new Error('not used by this suite');
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  parseWebhookEvent(): PaymentWebhookEvent {
    throw new Error('not used by this suite');
  }
}

function extractInviteToken(message: EmailMessage): string {
  const match = /token=([a-f0-9]+)/.exec(message.text ?? '');
  if (!match) {
    throw new Error('No invite token found in email body');
  }
  return match[1];
}

describe('Node visibility + private dispatch (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let memberships: Repository<NodeMembershipEntity>;
  let nodes: Repository<NodeEntity>;
  let inviteTokens: Repository<InviteTokenEntity>;
  let paymentIntents: Repository<PaymentIntentEntity>;
  let pricingRules: Repository<PricingRuleEntity>;
  let poller: OutboxPollerService;
  let jwtService: JwtService;
  let fakeSender: FakeNotificationSender;
  let adminCookie: string;

  const emailPattern = '%@private-dispatch.e2e.test';
  const nodeNamePattern = 'private-dispatch.e2e.test%';
  const password = 'Correct-Horse-Battery-1';

  function asAdmin(req: request.Test): request.Test {
    return req.set('Cookie', [adminCookie]);
  }

  async function loginAs(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const setCookie = response.headers['set-cookie'] as unknown as
      string[] | undefined;
    const accessCookie = setCookie?.find((c) => c.startsWith('access_token='));
    if (!accessCookie) {
      throw new Error('No access_token cookie in login response');
    }
    return accessCookie.split(';')[0];
  }

  async function registerAndLoginConsumer(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Consumer',
        lastName: 'Tester',
        email,
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.CONSUMER,
      })
      .expect(201);
    return loginAs(email);
  }

  async function registerLoginOnboardApprove(
    email: string,
    nodeName: string,
  ): Promise<{ cookie: string; nodeId: string }> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Owner',
        lastName: 'Tester',
        email,
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.NODE_OPERATOR,
      })
      .expect(201);

    const cookie = await loginAs(email);

    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Cookie', [cookie])
      .send({ phone: '+2348012345678' })
      .expect(200);

    const onboardResponse = await request(app.getHttpServer())
      .post('/api/v1/node-operators/onboarding')
      .set('Cookie', [cookie])
      .send({
        name: `${nodeNamePattern.replace('%', '')}${nodeName}`,
        address: '1 Test Avenue',
        city: 'Lagos',
        state: 'Lagos',
        latitude: 6.45,
        longitude: 3.47,
        capacity: 30,
      })
      .expect(201);

    const data = (onboardResponse.body as SuccessBody).data as {
      profileId: string;
      node: { id: string };
    };

    await asAdmin(
      request(app.getHttpServer()).patch(
        `/api/v1/node-operators/${data.profileId}/approve`,
      ),
    ).expect(200);

    return { cookie, nodeId: data.node.id };
  }

  async function addPendingNode(
    ownerCookie: string,
    nodeName: string,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/node-operators/nodes')
      .set('Cookie', [ownerCookie])
      .send({
        name: `${nodeNamePattern.replace('%', '')}${nodeName}`,
        address: '2 Test Avenue',
        city: 'Lagos',
        state: 'Lagos',
        latitude: 6.46,
        longitude: 3.48,
        capacity: 20,
      })
      .expect(201);
    return ((response.body as SuccessBody).data as { node: { id: string } })
      .node.id;
  }

  async function findInviteEmail(email: string): Promise<EmailMessage> {
    for (let attempt = 0; attempt < 10; attempt++) {
      await poller.poll();
      const message = fakeSender.sentMessages.find((m) => m.to === email);
      if (message) {
        return message;
      }
    }
    throw new Error(`No invite email observed for ${email}`);
  }

  async function inviteAndConfirmStaff(
    ownerCookie: string,
    nodeId: string,
    email: string,
  ): Promise<string> {
    await request(app.getHttpServer())
      .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
      .set('Cookie', [ownerCookie])
      .send({
        firstName: 'Staff',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
      })
      .expect(201);

    const message = await findInviteEmail(email);
    const token = extractInviteToken(message);

    await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token,
        password,
        passwordConfirmation: password,
        consentAccepted: true,
      })
      .expect(200);

    return loginAs(email);
  }

  function setVisibility(
    ownerCookie: string,
    nodeId: string,
    isPubliclyVisible: boolean,
  ): request.Test {
    return request(app.getHttpServer())
      .patch(`/api/v1/node-operators/nodes/${nodeId}/visibility`)
      .set('Cookie', [ownerCookie])
      .send({ isPubliclyVisible });
  }

  function dispatch(
    callerCookie: string,
    nodeId: string,
    overrides: Record<string, unknown> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .post(`/api/v1/node-operators/nodes/${nodeId}/dispatch`)
      .set('Cookie', [callerCookie])
      .send({
        destinationNodeId: overrides.destinationNodeId,
        receiverFullName: 'Receiver Tester',
        receiverEmail: 'receiver@private-dispatch.e2e.test',
        receiverPhone: '+2348012345678',
        parcelDescription: 'A dispatched parcel',
        parcelSize: 'small',
        ...overrides,
      });
  }

  beforeAll(async () => {
    fakeSender = new FakeNotificationSender();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NOTIFICATION_SENDER)
      .useValue(fakeSender)
      .overrideProvider(PaystackPaymentProvider)
      .useValue(new FakePaystackPaymentProvider())
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    memberships = moduleFixture.get(getRepositoryToken(NodeMembershipEntity));
    nodes = moduleFixture.get(getRepositoryToken(NodeEntity));
    inviteTokens = moduleFixture.get(getRepositoryToken(InviteTokenEntity));
    paymentIntents = moduleFixture.get(getRepositoryToken(PaymentIntentEntity));
    pricingRules = moduleFixture.get(getRepositoryToken(PricingRuleEntity));
    poller = moduleFixture.get(OutboxPollerService);
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@private-dispatch.e2e.test',
        passwordHash: await hashPassword(password),
        firstName: 'Admin',
        lastName: 'Tester',
        phone: '+2348012345678',
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
      }),
    );
    const adminToken = jwtService.sign({ sub: admin.id, role: UserRole.ADMIN });
    adminCookie = `access_token=${adminToken}`;

    await asAdmin(request(app.getHttpServer()).post('/api/v1/admin/pricing'))
      .send({ baseFeeNaira: 500, perKmRateNaira: 100, destinationFeeNaira: 50 })
      .expect(201);
  });

  beforeEach(() => {
    fakeSender.sentMessages = [];
  });

  afterAll(async () => {
    try {
      await paymentIntents
        .createQueryBuilder()
        .delete()
        .where(
          '"originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern)',
          { pattern: nodeNamePattern },
        )
        .execute();
      await memberships
        .createQueryBuilder()
        .delete()
        .where('"nodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern)', {
          pattern: nodeNamePattern,
        })
        .execute();
      const testUsers = await users
        .createQueryBuilder()
        .where('email LIKE :pattern', { pattern: emailPattern })
        .getMany();
      for (const user of testUsers) {
        await inviteTokens.delete({ userId: user.id });
      }
      await nodes
        .createQueryBuilder()
        .delete()
        .where('name LIKE :pattern', { pattern: nodeNamePattern })
        .execute();
      await pricingRules
        .createQueryBuilder()
        .delete()
        .where(
          '"createdByAdminId" IN (SELECT id FROM users WHERE email LIKE :pattern)',
          { pattern: emailPattern },
        )
        .execute();
      await users
        .createQueryBuilder()
        .delete()
        .where('email LIKE :pattern', { pattern: emailPattern })
        .execute();
    } finally {
      await app.close();
    }
  });

  describe('PATCH /node-operators/nodes/:nodeId/visibility', () => {
    let ownerCookie: string;
    let nodeId: string;
    let staffCookie: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'visibility-owner@private-dispatch.e2e.test',
        'visibility-node',
      );
      ownerCookie = owner.cookie;
      nodeId = owner.nodeId;
      staffCookie = await inviteAndConfirmStaff(
        ownerCookie,
        nodeId,
        'visibility-staff@private-dispatch.e2e.test',
      );
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/nodes/${nodeId}/visibility`)
        .send({ isPubliclyVisible: false })
        .expect(401);
    });

    it('rejects a staff caller (owner-only route)', async () => {
      const response = await setVisibility(staffCookie, nodeId, false).expect(
        403,
      );
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('404s for a Node the caller has no membership at', async () => {
      await setVisibility(
        ownerCookie,
        '00000000-0000-0000-0000-000000000000',
        false,
      ).expect(404);
    });

    it('rejects toggling a Node that is not active yet', async () => {
      const pendingNodeId = await addPendingNode(ownerCookie, 'pending-vis');
      const response = await setVisibility(
        ownerCookie,
        pendingNodeId,
        false,
      ).expect(403);
      expect((response.body as ErrorBody).error.code).toBe('NODE_NOT_ACTIVE');
    });

    it('toggles isPubliclyVisible and it round-trips', async () => {
      const off = await setVisibility(ownerCookie, nodeId, false).expect(200);
      expect(
        (
          (off.body as SuccessBody).data as {
            node: { isPubliclyVisible: boolean };
          }
        ).node.isPubliclyVisible,
      ).toBe(false);

      const on = await setVisibility(ownerCookie, nodeId, true).expect(200);
      expect(
        (
          (on.body as SuccessBody).data as {
            node: { isPubliclyVisible: boolean };
          }
        ).node.isPubliclyVisible,
      ).toBe(true);
    });
  });

  describe('search/list exclusion for a private Node', () => {
    let ownerCookie: string;
    let nodeId: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'search-owner@private-dispatch.e2e.test',
        'search-node',
      );
      ownerCookie = owner.cookie;
      nodeId = owner.nodeId;
      await setVisibility(ownerCookie, nodeId, false).expect(200);
    });

    it('excludes the private Node from GET /nodes for a non-Admin', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'search-consumer@private-dispatch.e2e.test',
      );
      const response = await request(app.getHttpServer())
        .get('/api/v1/nodes')
        .set('Cookie', [consumerCookie])
        .query({ limit: 100 })
        .expect(200);
      const ids = (response.body as SuccessListBody).data.items.map(
        (item) => item.id,
      );
      expect(ids).not.toContain(nodeId);
    });

    it('excludes the private Node from GET /nodes/nearby', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'search-nearby-consumer@private-dispatch.e2e.test',
      );
      const response = await request(app.getHttpServer())
        .get('/api/v1/nodes/nearby')
        .set('Cookie', [consumerCookie])
        .query({ latitude: 6.45, longitude: 3.47, radiusKm: 50, limit: 100 })
        .expect(200);
      const ids = (response.body as SuccessListBody).data.items.map(
        (item) => item.id,
      );
      expect(ids).not.toContain(nodeId);
    });

    it('still includes the private Node for an Admin, with isPubliclyVisible: false', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).get('/api/v1/nodes'),
      )
        .query({ limit: 100 })
        .expect(200);
      const found = (response.body as SuccessListBody).data.items.find(
        (item) => item.id === nodeId,
      );
      expect(found).toBeDefined();
      expect(found?.isPubliclyVisible).toBe(false);
    });
  });

  describe('POST /payments/intents blocked against a private Node', () => {
    let ownerCookie: string;
    let privateNodeId: string;
    let publicNodeId: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'blocked-owner@private-dispatch.e2e.test',
        'blocked-node',
      );
      ownerCookie = owner.cookie;
      privateNodeId = owner.nodeId;
      await setVisibility(ownerCookie, privateNodeId, false).expect(200);

      const publicOwner = await registerLoginOnboardApprove(
        'blocked-public-owner@private-dispatch.e2e.test',
        'blocked-public-node',
      );
      publicNodeId = publicOwner.nodeId;
    });

    it('404s when originNodeId is a private Node', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'blocked-origin-consumer@private-dispatch.e2e.test',
      );
      const response = await request(app.getHttpServer())
        .post('/api/v1/payments/intents')
        .set('Cookie', [consumerCookie])
        .send({
          originNodeId: privateNodeId,
          destinationNodeId: publicNodeId,
          receiverFullName: 'Receiver Tester',
          receiverEmail: 'receiver@private-dispatch.e2e.test',
          receiverPhone: '+2348012345678',
          parcelDescription: 'A parcel',
          parcelSize: 'small',
        })
        .expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('404s when destinationNodeId is a private Node', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'blocked-dest-consumer@private-dispatch.e2e.test',
      );
      const response = await request(app.getHttpServer())
        .post('/api/v1/payments/intents')
        .set('Cookie', [consumerCookie])
        .send({
          originNodeId: publicNodeId,
          destinationNodeId: privateNodeId,
          receiverFullName: 'Receiver Tester',
          receiverEmail: 'receiver@private-dispatch.e2e.test',
          receiverPhone: '+2348012345678',
          parcelDescription: 'A parcel',
          parcelSize: 'small',
        })
        .expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /node-operators/nodes/:nodeId/dispatch', () => {
    let ownerCookie: string;
    let nodeId: string;
    let staffCookie: string;
    let privateDestinationNodeId: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'dispatch-owner@private-dispatch.e2e.test',
        'dispatch-node',
      );
      ownerCookie = owner.cookie;
      nodeId = owner.nodeId;
      staffCookie = await inviteAndConfirmStaff(
        ownerCookie,
        nodeId,
        'dispatch-staff@private-dispatch.e2e.test',
      );

      const destinationOwner = await registerLoginOnboardApprove(
        'dispatch-dest-owner@private-dispatch.e2e.test',
        'dispatch-dest-node',
      );
      privateDestinationNodeId = destinationOwner.nodeId;
      await setVisibility(
        destinationOwner.cookie,
        privateDestinationNodeId,
        false,
      ).expect(200);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/dispatch`)
        .send({
          destinationNodeId: privateDestinationNodeId,
          receiverFullName: 'Receiver Tester',
          receiverEmail: 'receiver@private-dispatch.e2e.test',
          receiverPhone: '+2348012345678',
          parcelDescription: 'A dispatched parcel',
          parcelSize: 'small',
        })
        .expect(401);
    });

    it('404s for a Node the caller has no membership at', async () => {
      const response = await dispatch(
        ownerCookie,
        '00000000-0000-0000-0000-000000000000',
        { destinationNodeId: privateDestinationNodeId },
      ).expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('rejects dispatching from a Node that is not active yet', async () => {
      const pendingNodeId = await addPendingNode(
        ownerCookie,
        'pending-dispatch',
      );
      const response = await dispatch(ownerCookie, pendingNodeId, {
        destinationNodeId: privateDestinationNodeId,
      }).expect(403);
      expect((response.body as ErrorBody).error.code).toBe('NODE_NOT_ACTIVE');
    });

    it('lets the owner dispatch to a private destination Node', async () => {
      const response = await dispatch(ownerCookie, nodeId, {
        destinationNodeId: privateDestinationNodeId,
      }).expect(201);
      const data = (response.body as SuccessBody).data;
      expect(data.originNodeId).toBe(nodeId);
      expect(data.destinationNodeId).toBe(privateDestinationNodeId);
      expect(data.status).toBe('pending');
      expect(data.authorizationUrl).toContain('fake.paystack.test');

      const intent = await paymentIntents.findOneBy({ id: data.id as string });
      const owner = await users.findOneByOrFail({
        email: 'dispatch-owner@private-dispatch.e2e.test',
      });
      expect(intent?.consumerId).toBe(owner.id);
    });

    it('lets staff dispatch from the same Node', async () => {
      const response = await dispatch(staffCookie, nodeId, {
        destinationNodeId: privateDestinationNodeId,
      }).expect(201);
      const data = (response.body as SuccessBody).data;
      expect(data.status).toBe('pending');
    });
  });
});
