import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { hashToken } from '../../src/common/crypto/hash-token.util';
import { hashRefreshToken } from '../../src/modules/identity/domain/refresh-token-hasher';
import { UserRole } from '../../src/modules/identity/domain/user-role.enum';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { PasswordResetTokenEntity } from '../../src/modules/identity/infrastructure/entities/password-reset-token.entity';
import { RefreshTokenEntity } from '../../src/modules/identity/infrastructure/entities/refresh-token.entity';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { OutboxPollerService } from '../../src/modules/notifications/application/outbox-poller.service';
import { EmailMessage } from '../../src/modules/notifications/domain/email-message';
import { NotificationSender } from '../../src/modules/notifications/domain/notification-sender.port';
import { NOTIFICATION_SENDER } from '../../src/modules/notifications/infrastructure/notification-sender.token';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

class FakeNotificationSender implements NotificationSender {
  sentMessages: EmailMessage[] = [];

  sendEmail(message: EmailMessage): Promise<void> {
    this.sentMessages.push(message);
    return Promise.resolve();
  }
}

function extractResetToken(message: EmailMessage): string {
  const match = /token=([a-f0-9]+)/.exec(message.text ?? '');
  if (!match) {
    throw new Error('No reset token found in email body');
  }
  return match[1];
}

describe('Password reset (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let refreshTokens: Repository<RefreshTokenEntity>;
  let resetTokens: Repository<PasswordResetTokenEntity>;
  let poller: OutboxPollerService;
  let fakeSender: FakeNotificationSender;

  const emailPattern = '%@password-reset.e2e.test';
  const password = 'Correct-Horse-Battery-1';
  const newPassword = 'New-Correct-Horse-2';

  async function register(email: string): Promise<void> {
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Reset',
      lastName: 'Tester',
      email,
      phone: '+2348012345678',
      password,
      passwordConfirmation: password,
      consentAccepted: true,
    });
  }

  async function requestResetAndGetToken(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email })
      .expect(200);
    await poller.poll();

    const message = fakeSender.sentMessages.at(-1);
    if (!message) {
      throw new Error('No reset email was enqueued/sent');
    }
    return extractResetToken(message);
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
    refreshTokens = moduleFixture.get(getRepositoryToken(RefreshTokenEntity));
    resetTokens = moduleFixture.get(
      getRepositoryToken(PasswordResetTokenEntity),
    );
    poller = moduleFixture.get(OutboxPollerService);
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
      await refreshTokens.delete({ userId: user.id });
      await resetTokens.delete({ userId: user.id });
    }
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: emailPattern })
      .execute();
    await app.close();
  });

  it('emails a reset link, and the link sets a new password and revokes existing sessions', async () => {
    const email = 'happy-path@password-reset.e2e.test';
    await register(email);

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const oldRefreshCookie = (
      loginResponse.headers['set-cookie'] as unknown as string[]
    ).find((c) => c.startsWith('refresh_token='))!;
    const oldRawRefreshToken = oldRefreshCookie.split(';')[0].split('=')[1];

    const rawResetToken = await requestResetAndGetToken(email);
    const message = fakeSender.sentMessages.at(-1)!;
    expect(message.to).toBe(email);
    expect(message.text).toContain(`/reset-password?token=${rawResetToken}`);

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: rawResetToken,
        password: newPassword,
        passwordConfirmation: newPassword,
      })
      .expect(200);

    // Old password no longer works.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(401);

    // New password does.
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: newPassword })
      .expect(200);

    // Every session that existed before the reset is dead.
    const oldStored = await refreshTokens.findOneByOrFail({
      tokenHash: hashRefreshToken(oldRawRefreshToken),
    });
    expect(oldStored.revokedAt).not.toBeNull();

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [oldRefreshCookie])
      .expect(401);

    // A "your password changed" notice went out too.
    await poller.poll();
    const changedNotice = fakeSender.sentMessages.find(
      (m) => m.subject === 'Your Locoomo password was changed',
    );
    expect(changedNotice?.to).toBe(email);
  });

  it('responds identically for an unregistered email and sends nothing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'nobody@password-reset.e2e.test' })
      .expect(200);

    await poller.poll();
    expect(fakeSender.sentMessages).toHaveLength(0);
  });

  it('responds identically for an invited account with no password set and sends nothing', async () => {
    const email = 'invited@password-reset.e2e.test';
    await users.save(
      users.create({
        email,
        passwordHash: null,
        firstName: 'Invited',
        lastName: 'Tester',
        phone: '+2348012345678',
        role: UserRole.NODE_OPERATOR,
        status: UserStatus.INVITED,
        consentAcceptedAt: null,
      }),
    );

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/request')
      .send({ email })
      .expect(200);

    await poller.poll();
    expect(fakeSender.sentMessages).toHaveLength(0);
  });

  it('rejects an unrecognized reset token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: 'not-a-real-token',
        password: newPassword,
        passwordConfirmation: newPassword,
      })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects an expired reset token', async () => {
    const email = 'expired@password-reset.e2e.test';
    await register(email);

    const rawResetToken = await requestResetAndGetToken(email);
    await resetTokens.update(
      { tokenHash: hashToken(rawResetToken) },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: rawResetToken,
        password: newPassword,
        passwordConfirmation: newPassword,
      })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects reusing an already-consumed reset token', async () => {
    const email = 'reuse@password-reset.e2e.test';
    await register(email);
    const rawResetToken = await requestResetAndGetToken(email);

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: rawResetToken,
        password: newPassword,
        passwordConfirmation: newPassword,
      })
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: rawResetToken,
        password: 'Another-New-Password-3',
        passwordConfirmation: 'Another-New-Password-3',
      })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('supersedes an earlier unused reset token when a new one is requested', async () => {
    const email = 'supersede@password-reset.e2e.test';
    await register(email);

    const firstToken = await requestResetAndGetToken(email);
    const secondToken = await requestResetAndGetToken(email);
    expect(secondToken).not.toBe(firstToken);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: firstToken,
        password: newPassword,
        passwordConfirmation: newPassword,
      })
      .expect(401);
    expect((response.body as ErrorBody).error.code).toBe('INVALID_RESET_TOKEN');

    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: secondToken,
        password: newPassword,
        passwordConfirmation: newPassword,
      })
      .expect(200);
  });

  it('rejects a malformed confirm payload with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: 'x', password: 'short', passwordConfirmation: 'short' })
      .expect(400);
  });

  it('rejects a mismatched password confirmation with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({
        token: 'x',
        password: newPassword,
        passwordConfirmation: 'does-not-match',
      })
      .expect(400);
  });
});
