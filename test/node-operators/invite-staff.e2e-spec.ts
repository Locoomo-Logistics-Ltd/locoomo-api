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
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { InviteTokenEntity } from '../../src/modules/identity/infrastructure/entities/invite-token.entity';
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { OutboxPollerService } from '../../src/modules/notifications/application/outbox-poller.service';
import { EmailMessage } from '../../src/modules/notifications/domain/email-message';
import { NotificationSender } from '../../src/modules/notifications/domain/notification-sender.port';
import { NOTIFICATION_SENDER } from '../../src/modules/notifications/infrastructure/notification-sender.token';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

class FakeNotificationSender implements NotificationSender {
  sentMessages: EmailMessage[] = [];

  sendEmail(message: EmailMessage): Promise<void> {
    this.sentMessages.push(message);
    return Promise.resolve();
  }
}

function extractInviteToken(message: EmailMessage): string {
  const match = /token=([a-f0-9]+)/.exec(message.text ?? '');
  if (!match) {
    throw new Error('No invite token found in email body');
  }
  return match[1];
}

describe('Node staff invite (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let memberships: Repository<NodeMembershipEntity>;
  let nodes: Repository<NodeEntity>;
  let inviteTokens: Repository<InviteTokenEntity>;
  let poller: OutboxPollerService;
  let jwtService: JwtService;
  let fakeSender: FakeNotificationSender;
  let adminCookie: string;

  const emailPattern = '%@invite-staff.e2e.test';
  const nodeNamePattern = 'invite-staff.e2e.test%';
  const password = 'Correct-Horse-Battery-1';

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

  async function registerLoginOnboardApprove(
    email: string,
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

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const setCookie = loginResponse.headers['set-cookie'] as unknown as
      string[] | undefined;
    const accessCookie = setCookie?.find((c) => c.startsWith('access_token='));
    if (!accessCookie) {
      throw new Error('No access_token cookie in login response');
    }
    const cookie = accessCookie.split(';')[0];

    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Cookie', [cookie])
      .send({ phone: '+2348012345678' })
      .expect(200);

    const onboardResponse = await request(app.getHttpServer())
      .post('/api/v1/node-operators/onboarding')
      .set('Cookie', [cookie])
      .send({
        name: `${nodeNamePattern.replace('%', '')}${email}`,
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

    await request(app.getHttpServer())
      .patch(`/api/v1/node-operators/${data.profileId}/approve`)
      .set('Cookie', [adminCookie])
      .expect(200);

    return { cookie, nodeId: data.node.id };
  }

  beforeAll(async () => {
    fakeSender = new FakeNotificationSender();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NOTIFICATION_SENDER)
      .useValue(fakeSender)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    memberships = moduleFixture.get(getRepositoryToken(NodeMembershipEntity));
    nodes = moduleFixture.get(getRepositoryToken(NodeEntity));
    inviteTokens = moduleFixture.get(getRepositoryToken(InviteTokenEntity));
    poller = moduleFixture.get(OutboxPollerService);
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@invite-staff.e2e.test',
        passwordHash: await hashPassword('Correct-Horse-Battery-1'),
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
  });

  beforeEach(() => {
    fakeSender.sentMessages = [];
  });

  afterAll(async () => {
    const testUsers = await users
      .createQueryBuilder()
      .where('email LIKE :pattern', { pattern: emailPattern })
      .getMany();
    for (const user of testUsers) {
      await inviteTokens.delete({ userId: user.id });
    }
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: emailPattern })
      .execute();
    await nodes
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: nodeNamePattern })
      .execute();
    await app.close();
  });

  describe('POST /node-operators/nodes/:nodeId/staff/invite', () => {
    let ownerCookie: string;
    let nodeId: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'owner@invite-staff.e2e.test',
      );
      ownerCookie = owner.cookie;
      nodeId = owner.nodeId;
    });

    it('rejects an unauthenticated request', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
        .send({
          firstName: 'Staff',
          lastName: 'Tester',
          email: 'noauth-staff@invite-staff.e2e.test',
          phone: '+2348012345678',
        })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a non-NodeOperator role', async () => {
      const consumerToken = jwtService.sign({
        sub: 'some-consumer-id',
        role: UserRole.CONSUMER,
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
        .set('Cookie', [`access_token=${consumerToken}`])
        .send({
          firstName: 'Staff',
          lastName: 'Tester',
          email: 'wrongrole-staff@invite-staff.e2e.test',
          phone: '+2348012345678',
        })
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('404s for a Node the caller does not own', async () => {
      await request(app.getHttpServer())
        .post(
          '/api/v1/node-operators/nodes/00000000-0000-0000-0000-000000000000/staff/invite',
        )
        .set('Cookie', [ownerCookie])
        .send({
          firstName: 'Staff',
          lastName: 'Tester',
          email: 'notmine-staff@invite-staff.e2e.test',
          phone: '+2348012345678',
        })
        .expect(404);
    });

    it('rejects inviting staff to a Node that is not active yet', async () => {
      const pendingResponse = await request(app.getHttpServer())
        .post('/api/v1/node-operators/nodes')
        .set('Cookie', [ownerCookie])
        .send({
          name: `${nodeNamePattern.replace('%', '')}pending`,
          address: '2 Test Avenue',
          city: 'Lagos',
          state: 'Lagos',
          latitude: 6.46,
          longitude: 3.48,
          capacity: 20,
        })
        .expect(201);
      const pendingNodeId = (
        (pendingResponse.body as SuccessBody).data as { node: { id: string } }
      ).node.id;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${pendingNodeId}/staff/invite`)
        .set('Cookie', [ownerCookie])
        .send({
          firstName: 'Staff',
          lastName: 'Tester',
          email: 'pending-node-staff@invite-staff.e2e.test',
          phone: '+2348012345678',
        })
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('NODE_NOT_ACTIVE');
    });

    it('invites staff, creating an invited node_staff account and a staff membership', async () => {
      const email = 'happy-path-staff@invite-staff.e2e.test';

      const response = await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
        .set('Cookie', [ownerCookie])
        .send({
          firstName: 'Staff',
          lastName: 'Tester',
          email,
          phone: '+2348012345678',
        })
        .expect(201);

      const data = (response.body as SuccessBody).data;
      expect(data.role).toBe('node_staff');
      expect(data.status).toBe('invited');
      expect(data.passwordHash).toBeUndefined();

      const stored = await users.findOneByOrFail({ email });
      expect(stored.status).toBe(UserStatus.INVITED);
      expect(stored.passwordHash).toBeNull();

      const membership = await memberships.findOneByOrFail({
        userId: stored.id,
        nodeId,
      });
      expect(membership.roleAtNode).toBe('staff');

      const message = await findInviteEmail(email);
      expect(message.text).toContain('/accept-invite?token=');
    });

    it('rejects inviting an email that is already registered', async () => {
      const email = 'duplicate-staff@invite-staff.e2e.test';
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

      const response = await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
        .set('Cookie', [ownerCookie])
        .send({
          firstName: 'Staff',
          lastName: 'Tester',
          email,
          phone: '+2348012345678',
        })
        .expect(409);
      expect((response.body as ErrorBody).error.code).toBe(
        'EMAIL_ALREADY_REGISTERED',
      );
    });
  });

  describe('staff confirming and operating', () => {
    let ownerCookie: string;
    let nodeId: string;
    let staffEmail: string;
    let staffCookie: string;

    beforeAll(async () => {
      const owner = await registerLoginOnboardApprove(
        'operating-owner@invite-staff.e2e.test',
      );
      ownerCookie = owner.cookie;
      nodeId = owner.nodeId;

      staffEmail = 'operating-staff@invite-staff.e2e.test';
      await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
        .set('Cookie', [ownerCookie])
        .send({
          firstName: 'Staff',
          lastName: 'Tester',
          email: staffEmail,
          phone: '+2348012345678',
        })
        .expect(201);

      const message = await findInviteEmail(staffEmail);
      const rawToken = extractInviteToken(message);

      await request(app.getHttpServer())
        .post('/api/v1/auth/invite/confirm')
        .send({
          token: rawToken,
          password,
          passwordConfirmation: password,
          consentAccepted: true,
        })
        .expect(200);

      const loginResponse = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: staffEmail, password })
        .expect(200);
      const setCookie = loginResponse.headers['set-cookie'] as unknown as
        string[] | undefined;
      const accessCookie = setCookie?.find((c) =>
        c.startsWith('access_token='),
      );
      if (!accessCookie) {
        throw new Error('No access_token cookie in login response');
      }
      staffCookie = accessCookie.split(';')[0];
    });

    it('activates the staff account and lets them log in', async () => {
      const activated = await users.findOneByOrFail({ email: staffEmail });
      expect(activated.status).toBe(UserStatus.ACTIVE);
      expect(activated.role).toBe(UserRole.NODE_STAFF);
    });

    it('lets staff reach a Node-operator-facing handoff route for their Node', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders')
        .set('Cookie', [staffCookie])
        .expect(200);
    });

    it('blocks staff from the payout-account route', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/nodes/${nodeId}/payout-account`)
        .set('Cookie', [staffCookie])
        .send({
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0123456789',
        })
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('blocks staff from inviting further staff', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/node-operators/nodes/${nodeId}/staff/invite`)
        .set('Cookie', [staffCookie])
        .send({
          firstName: 'Second',
          lastName: 'Staff',
          email: 'second-staff@invite-staff.e2e.test',
          phone: '+2348012345678',
        })
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('blocks staff from the Node earnings route', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/earnings/my-node')
        .set('Cookie', [staffCookie])
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });
  });
});
