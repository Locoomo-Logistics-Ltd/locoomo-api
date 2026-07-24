import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserRole } from '../../src/modules/identity/domain/user-role.enum';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { InviteTokenEntity } from '../../src/modules/identity/infrastructure/entities/invite-token.entity';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
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

describe('Admin-provisioning invite (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let inviteTokens: Repository<InviteTokenEntity>;
  let poller: OutboxPollerService;
  let jwtService: JwtService;
  let fakeSender: FakeNotificationSender;
  let adminCookie: string;

  const emailPattern = '%@admin-invite.e2e.test';
  const newPassword = 'New-Correct-Horse-2';

  // Same shared-queue caveat as the password-reset/email-verification specs
  // — poll in a bounded loop and match on recipient rather than assuming
  // the last message processed is ours.
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

  function invite(
    body: Record<string, unknown>,
    cookie = adminCookie,
  ): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/users/invite')
      .set('Cookie', [cookie])
      .send(body);
  }

  async function inviteAndGetToken(
    email: string,
    role: UserRole,
  ): Promise<string> {
    await invite({
      firstName: 'Invited',
      lastName: 'Tester',
      email,
      phone: '+2348012345678',
      role,
    }).expect(201);

    const message = await findInviteEmail(email);
    return extractInviteToken(message);
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
    inviteTokens = moduleFixture.get(getRepositoryToken(InviteTokenEntity));
    poller = moduleFixture.get(OutboxPollerService);
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@admin-invite.e2e.test',
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
    await app.close();
  });

  it('rejects an unauthenticated invite request', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/users/invite')
      .send({
        firstName: 'Nope',
        lastName: 'Tester',
        email: 'noauth@admin-invite.e2e.test',
        phone: '+2348012345678',
        role: UserRole.NODE_OPERATOR,
      })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an invite from an authenticated non-admin user', async () => {
    const consumerToken = jwtService.sign({
      sub: 'some-consumer-id',
      role: UserRole.CONSUMER,
    });

    const response = await invite(
      {
        firstName: 'Nope',
        lastName: 'Tester',
        email: 'wrongrole@admin-invite.e2e.test',
        phone: '+2348012345678',
        role: UserRole.NODE_OPERATOR,
      },
      `access_token=${consumerToken}`,
    ).expect(403);

    expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
  });

  it('rejects inviting a Consumer role', async () => {
    const response = await invite({
      firstName: 'Nope',
      lastName: 'Tester',
      email: 'consumerrole@admin-invite.e2e.test',
      phone: '+2348012345678',
      role: UserRole.CONSUMER,
    }).expect(400);

    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_FAILED');
  });

  it('invites a NodeOperator, creating an invited-status user with no password, and emails a link', async () => {
    const email = 'happy-path@admin-invite.e2e.test';

    const response = await invite({
      firstName: 'Invited',
      lastName: 'Tester',
      email,
      phone: '+2348012345678',
      role: UserRole.NODE_OPERATOR,
    }).expect(201);

    const data = (response.body as SuccessBody).data;
    expect(data.status).toBe('invited');
    expect(data.role).toBe('node_operator');
    expect(data.passwordHash).toBeUndefined();

    const stored = await users.findOneByOrFail({ email });
    expect(stored.passwordHash).toBeNull();
    expect(stored.status).toBe(UserStatus.INVITED);

    const message = await findInviteEmail(email);
    expect(message.text).toContain('/accept-invite?token=');
  });

  it('rejects inviting an email that is already registered', async () => {
    const email = 'duplicate@admin-invite.e2e.test';
    await invite({
      firstName: 'First',
      lastName: 'Tester',
      email,
      phone: '+2348012345678',
      role: UserRole.RIDER,
    }).expect(201);

    const response = await invite({
      firstName: 'Second',
      lastName: 'Tester',
      email,
      phone: '+2348012345678',
      role: UserRole.RIDER,
    }).expect(409);

    expect((response.body as ErrorBody).error.code).toBe(
      'EMAIL_ALREADY_REGISTERED',
    );
  });

  it('confirming the invite sets a password, activates the account, and lets them log in', async () => {
    const email = 'confirm@admin-invite.e2e.test';
    const rawToken = await inviteAndGetToken(email, UserRole.RIDER);

    await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token: rawToken,
        password: newPassword,
        passwordConfirmation: newPassword,
        consentAccepted: true,
      })
      .expect(200);

    const activated = await users.findOneByOrFail({ email });
    expect(activated.status).toBe(UserStatus.ACTIVE);
    expect(activated.passwordHash).not.toBeNull();
    expect(activated.consentAcceptedAt).not.toBeNull();
    expect(activated.emailVerifiedAt).not.toBeNull();

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: newPassword })
      .expect(200);
  });

  it('rejects an unrecognized invite token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token: 'not-a-real-token',
        password: newPassword,
        passwordConfirmation: newPassword,
        consentAccepted: true,
      })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_INVITE_TOKEN',
    );
  });

  it('rejects an expired invite token', async () => {
    const email = 'expired@admin-invite.e2e.test';
    const rawToken = await inviteAndGetToken(email, UserRole.NODE_OPERATOR);

    const stored = await users.findOneByOrFail({ email });
    await inviteTokens.update(
      { userId: stored.id },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token: rawToken,
        password: newPassword,
        passwordConfirmation: newPassword,
        consentAccepted: true,
      })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_INVITE_TOKEN',
    );
  });

  it('rejects reusing an already-consumed invite token', async () => {
    const email = 'reuse@admin-invite.e2e.test';
    const rawToken = await inviteAndGetToken(email, UserRole.ADMIN);

    await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token: rawToken,
        password: newPassword,
        passwordConfirmation: newPassword,
        consentAccepted: true,
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token: rawToken,
        password: 'Another-New-Password-3',
        passwordConfirmation: 'Another-New-Password-3',
        consentAccepted: true,
      })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_INVITE_TOKEN',
    );
  });

  it('rejects a malformed confirm payload without consent accepted', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token: 'x',
        password: newPassword,
        passwordConfirmation: newPassword,
        consentAccepted: false,
      })
      .expect(400);

    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a mismatched password confirmation', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/invite/confirm')
      .send({
        token: 'x',
        password: newPassword,
        passwordConfirmation: 'does-not-match',
        consentAccepted: true,
      })
      .expect(400);
  });
});
