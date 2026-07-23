import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { hashToken } from '../../src/common/crypto/hash-token.util';
import { EmailVerificationTokenEntity } from '../../src/modules/identity/infrastructure/entities/email-verification-token.entity';
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

function extractVerificationToken(message: EmailMessage): string {
  const match = /token=([a-f0-9]+)/.exec(message.text ?? '');
  if (!match) {
    throw new Error('No verification token found in email body');
  }
  return match[1];
}

describe('Email verification (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let verificationTokens: Repository<EmailVerificationTokenEntity>;
  let poller: OutboxPollerService;
  let fakeSender: FakeNotificationSender;

  const emailPattern = '%@email-verification.e2e.test';
  const password = 'Correct-Horse-Battery-1';

  // Other suites (register, ...) enqueue real outbox rows against the same
  // shared table and never drain them (the automatic @Interval poll is
  // disabled in test env). A poll() here can legitimately process a batch
  // of unrelated backlog before/alongside this email, so find our own
  // message by recipient rather than assuming it's the last one processed,
  // and poll in a bounded loop rather than assuming one call reaches it.
  async function registerAndGetToken(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Verify',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
      })
      .expect(201);

    for (let attempt = 0; attempt < 10; attempt++) {
      await poller.poll();
      const message = fakeSender.sentMessages.find((m) => m.to === email);
      if (message) {
        return extractVerificationToken(message);
      }
    }
    throw new Error(`No verification email observed for ${email}`);
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
    verificationTokens = moduleFixture.get(
      getRepositoryToken(EmailVerificationTokenEntity),
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
      await verificationTokens.delete({ userId: user.id });
    }
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: emailPattern })
      .execute();
    await app.close();
  });

  it('emails a verification link on register, and the link marks the email verified', async () => {
    const email = 'happy-path@email-verification.e2e.test';
    const rawToken = await registerAndGetToken(email);

    const message = fakeSender.sentMessages.find((m) => m.to === email)!;
    expect(message.text).toContain(`/verify-email?token=${rawToken}`);

    const beforeVerify = await users.findOneByOrFail({ email });
    expect(beforeVerify.emailVerifiedAt).toBeNull();

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: rawToken })
      .expect(200);

    const afterVerify = await users.findOneByOrFail({ email });
    expect(afterVerify.emailVerifiedAt).not.toBeNull();
  });

  it('rejects an unrecognized verification token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: 'not-a-real-token' })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_VERIFICATION_TOKEN',
    );
  });

  it('rejects an expired verification token', async () => {
    const email = 'expired@email-verification.e2e.test';
    const rawToken = await registerAndGetToken(email);

    await verificationTokens.update(
      { tokenHash: hashToken(rawToken) },
      { expiresAt: new Date(Date.now() - 1000) },
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: rawToken })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_VERIFICATION_TOKEN',
    );
  });

  it('rejects reusing an already-consumed verification token', async () => {
    const email = 'reuse@email-verification.e2e.test';
    const rawToken = await registerAndGetToken(email);

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: rawToken })
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: rawToken })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_VERIFICATION_TOKEN',
    );
  });

  it('rejects a malformed verify payload with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({})
      .expect(400);
  });
});
