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
  data: Record<string, unknown>[];
}

class FakeNotificationSender implements NotificationSender {
  sentMessages: EmailMessage[] = [];

  sendEmail(message: EmailMessage): Promise<void> {
    this.sentMessages.push(message);
    return Promise.resolve();
  }
}

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

describe('Node staff removal (e2e)', () => {
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

  const emailPattern = '%@remove-staff.e2e.test';
  const nodeNamePattern = 'remove-staff.e2e.test%';
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
  ): Promise<{ cookie: string; userId: string }> {
    const inviteResponse = await request(app.getHttpServer())
      .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
      .set('Cookie', [ownerCookie])
      .send({
        firstName: 'Staff',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
      })
      .expect(201);
    const userId = (inviteResponse.body as SuccessBody).data.id as string;

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

    return { cookie: await loginAs(email), userId };
  }

  function listStaff(callerCookie: string, nodeId: string): request.Test {
    return request(app.getHttpServer())
      .get(`/api/v1/node-operators/nodes/${nodeId}/staff`)
      .set('Cookie', [callerCookie]);
  }

  function removeStaff(
    callerCookie: string,
    nodeId: string,
    userId: string,
  ): request.Test {
    return request(app.getHttpServer())
      .delete(`/api/v1/node-operators/nodes/${nodeId}/staff/${userId}`)
      .set('Cookie', [callerCookie]);
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
        email: 'admin@remove-staff.e2e.test',
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

  describe('GET /node-operators/nodes/:nodeId/staff', () => {
    let ownerCookie: string;
    let nodeId: string;
    let staffUserId: string;
    let staffCookie: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'list-owner@remove-staff.e2e.test',
        'list-node',
      );
      ownerCookie = owner.cookie;
      nodeId = owner.nodeId;
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/node-operators/nodes/${nodeId}/staff`)
        .expect(401);
    });

    it('404s for a Node the caller does not own', async () => {
      await listStaff(
        ownerCookie,
        '00000000-0000-0000-0000-000000000000',
      ).expect(404);
    });

    it('returns an empty list before any staff are invited', async () => {
      const response = await listStaff(ownerCookie, nodeId).expect(200);
      expect((response.body as SuccessListBody).data).toEqual([]);
    });

    it('rejects a staff caller (owner-only route)', async () => {
      const staff = await inviteAndConfirmStaff(
        ownerCookie,
        nodeId,
        'list-staff@remove-staff.e2e.test',
      );
      staffUserId = staff.userId;
      staffCookie = staff.cookie;

      const response = await listStaff(staffCookie, nodeId).expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('lists the invited staff for the owner', async () => {
      const response = await listStaff(ownerCookie, nodeId).expect(200);
      const items = (response.body as SuccessListBody).data;
      expect(items).toHaveLength(1);
      expect(items[0].userId).toBe(staffUserId);
      expect(items[0].email).toBe('list-staff@remove-staff.e2e.test');
    });
  });

  describe('DELETE /node-operators/nodes/:nodeId/staff/:userId', () => {
    let ownerCookie: string;
    let ownerUserId: string;
    let nodeId: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'remove-owner@remove-staff.e2e.test',
        'remove-node',
      );
      ownerCookie = owner.cookie;
      nodeId = owner.nodeId;
      const ownerRecord = await users.findOneByOrFail({
        email: 'remove-owner@remove-staff.e2e.test',
      });
      ownerUserId = ownerRecord.id;
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .delete(
          `/api/v1/node-operators/nodes/${nodeId}/staff/00000000-0000-0000-0000-000000000000`,
        )
        .expect(401);
    });

    it('404s for a Node the caller does not own', async () => {
      await removeStaff(
        ownerCookie,
        '00000000-0000-0000-0000-000000000000',
        '00000000-0000-0000-0000-000000000000',
      ).expect(404);
    });

    it('404s for a userId with no active membership at this Node', async () => {
      const response = await removeStaff(
        ownerCookie,
        nodeId,
        '00000000-0000-0000-0000-000000000000',
      ).expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('rejects removing an owner membership', async () => {
      const response = await removeStaff(
        ownerCookie,
        nodeId,
        ownerUserId,
      ).expect(400);
      expect((response.body as ErrorBody).error.code).toBe(
        'CANNOT_REMOVE_OWNER_MEMBERSHIP',
      );
    });

    it('rejects a staff caller (owner-only route)', async () => {
      const staff = await inviteAndConfirmStaff(
        ownerCookie,
        nodeId,
        'self-remove-staff@remove-staff.e2e.test',
      );

      const response = await removeStaff(
        staff.cookie,
        nodeId,
        staff.userId,
      ).expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('removes a staff member, who is then locked out of that Node', async () => {
      const staff = await inviteAndConfirmStaff(
        ownerCookie,
        nodeId,
        'happy-path-staff@remove-staff.e2e.test',
      );

      // Confirmed working before removal.
      await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/dispatch`)
        .set('Cookie', [staff.cookie])
        .send({
          destinationNodeId: nodeId,
          receiverFullName: 'Receiver Tester',
          receiverEmail: 'receiver@remove-staff.e2e.test',
          receiverPhone: '+2348012345678',
          parcelDescription: 'A parcel',
          parcelSize: 'small',
        })
        .expect(201);

      await removeStaff(ownerCookie, nodeId, staff.userId).expect(204);

      const membership = await memberships.findOneByOrFail({
        userId: staff.userId,
        nodeId,
      });
      expect(membership.status).toBe('removed');

      const listResponse = await listStaff(ownerCookie, nodeId).expect(200);
      const remainingIds = (listResponse.body as SuccessListBody).data.map(
        (item) => item.userId,
      );
      expect(remainingIds).not.toContain(staff.userId);

      const dispatchResponse = await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/dispatch`)
        .set('Cookie', [staff.cookie])
        .send({
          destinationNodeId: nodeId,
          receiverFullName: 'Receiver Tester',
          receiverEmail: 'receiver@remove-staff.e2e.test',
          receiverPhone: '+2348012345678',
          parcelDescription: 'A parcel',
          parcelSize: 'small',
        })
        .expect(404);
      expect((dispatchResponse.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('404s when removing an already-removed staff member again', async () => {
      const staff = await inviteAndConfirmStaff(
        ownerCookie,
        nodeId,
        'double-remove-staff@remove-staff.e2e.test',
      );

      await removeStaff(ownerCookie, nodeId, staff.userId).expect(204);
      const response = await removeStaff(
        ownerCookie,
        nodeId,
        staff.userId,
      ).expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });
  });
});
