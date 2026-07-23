import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { MAX_FAILED_LOGIN_ATTEMPTS } from '../../src/modules/identity/domain/account-lockout.constants';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { RefreshTokenEntity } from '../../src/modules/identity/infrastructure/entities/refresh-token.entity';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

describe('POST /api/v1/auth/login (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let refreshTokens: Repository<RefreshTokenEntity>;

  const email = 'login@login.e2e.test';
  const password = 'Correct-Horse-Battery-1';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    refreshTokens = moduleFixture.get(getRepositoryToken(RefreshTokenEntity));

    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Login',
      lastName: 'Tester',
      email,
      phone: '+2348012345678',
      password,
      passwordConfirmation: password,
      consentAccepted: true,
    });
  });

  afterAll(async () => {
    const user = await users.findOneBy({ email });
    if (user) {
      await refreshTokens.delete({ userId: user.id });
    }
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: '%@login.e2e.test' })
      .execute();
    await app.close();
  });

  it('logs in with correct credentials and sets session cookies', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.email).toBe(email);
    expect(data.passwordHash).toBeUndefined();

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    expect(setCookie).toBeDefined();

    const accessCookie = setCookie.find((c) => c.startsWith('access_token='));
    const refreshCookie = setCookie.find((c) => c.startsWith('refresh_token='));

    expect(accessCookie).toContain('HttpOnly');
    expect(accessCookie).toContain('SameSite=Strict');
    expect(accessCookie).toContain('Path=/');
    expect(accessCookie).not.toContain('Path=/api/v1/auth');

    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('SameSite=Strict');
    expect(refreshCookie).toContain('Path=/api/v1/auth');

    const user = await users.findOneByOrFail({ email });
    const storedTokens = await refreshTokens.find({
      where: { userId: user.id },
    });
    expect(storedTokens).toHaveLength(1);
    expect(storedTokens[0].revokedAt).toBeNull();
  });

  it('rejects a wrong password with 401 and a generic message', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'totally-wrong-password' })
      .expect(401);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an unknown email with the same generic 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@login.e2e.test', password })
      .expect(401);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a suspended account with 403 after password verification', async () => {
    const suspendedEmail = 'suspended@login.e2e.test';
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Suspended',
      lastName: 'Tester',
      email: suspendedEmail,
      phone: '+2348012345678',
      password,
      passwordConfirmation: password,
      consentAccepted: true,
    });
    await users.update(
      { email: suspendedEmail },
      { status: UserStatus.SUSPENDED },
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: suspendedEmail, password })
      .expect(403);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('rejects a malformed login payload with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);
  });

  it('locks the account after enough wrong passwords, then rejects even the correct one', async () => {
    const lockEmail = 'lockout@login.e2e.test';
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Lockout',
      lastName: 'Tester',
      email: lockEmail,
      phone: '+2348012345678',
      password,
      passwordConfirmation: password,
      consentAccepted: true,
    });

    for (let attempt = 0; attempt < MAX_FAILED_LOGIN_ATTEMPTS; attempt++) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: lockEmail, password: 'wrong-password' })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_CREDENTIALS',
      );
    }

    const lockedUser = await users.findOneByOrFail({ email: lockEmail });
    expect(lockedUser.lockedUntil).not.toBeNull();

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: lockEmail, password })
      .expect(401);
    expect((response.body as ErrorBody).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('logs in successfully and resets the failed-attempt counter once the lockout window has passed', async () => {
    const unlockEmail = 'unlock@login.e2e.test';
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Unlock',
      lastName: 'Tester',
      email: unlockEmail,
      phone: '+2348012345678',
      password,
      passwordConfirmation: password,
      consentAccepted: true,
    });

    await users.update(
      { email: unlockEmail },
      {
        failedLoginAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
        lockedUntil: new Date(Date.now() - 1000),
      },
    );

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: unlockEmail, password })
      .expect(200);

    const unlockedUser = await users.findOneByOrFail({ email: unlockEmail });
    expect(unlockedUser.failedLoginAttempts).toBe(0);
    expect(unlockedUser.lockedUntil).toBeNull();
  });
});
