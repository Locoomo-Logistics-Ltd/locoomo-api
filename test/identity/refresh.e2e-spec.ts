import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { hashRefreshToken } from '../../src/modules/identity/domain/refresh-token-hasher';
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

function extractCookieValue(setCookie: string[], name: string): string {
  const cookie = setCookie.find((c) => c.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`${name} cookie not found in Set-Cookie headers`);
  }
  return cookie.split(';')[0].split('=')[1];
}

describe('POST /api/v1/auth/refresh (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let refreshTokens: Repository<RefreshTokenEntity>;

  const emailPattern = '%@refresh.e2e.test';
  const password = 'Correct-Horse-Battery-1';

  async function registerAndLogin(email: string): Promise<string[]> {
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Refresh',
      lastName: 'Tester',
      email,
      phone: '+2348012345678',
      password,
      passwordConfirmation: password,
      consentAccepted: true,
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return response.headers['set-cookie'] as unknown as string[];
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    refreshTokens = moduleFixture.get(getRepositoryToken(RefreshTokenEntity));
  });

  afterAll(async () => {
    const testUsers = await users
      .createQueryBuilder()
      .where('email LIKE :pattern', { pattern: emailPattern })
      .getMany();
    for (const user of testUsers) {
      await refreshTokens.delete({ userId: user.id });
    }
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: emailPattern })
      .execute();
    await app.close();
  });

  it('rotates the refresh token and issues a new access token', async () => {
    const loginCookies = await registerAndLogin('rotate@refresh.e2e.test');
    const oldRefreshToken = extractCookieValue(loginCookies, 'refresh_token');

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', loginCookies)
      .expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.email).toBe('rotate@refresh.e2e.test');

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    const newRefreshToken = extractCookieValue(setCookie, 'refresh_token');
    expect(newRefreshToken).not.toBe(oldRefreshToken);

    const oldStored = await refreshTokens.findOneByOrFail({
      tokenHash: hashRefreshToken(oldRefreshToken),
    });
    expect(oldStored.revokedAt).not.toBeNull();

    const newStored = await refreshTokens.findOneByOrFail({
      tokenHash: hashRefreshToken(newRefreshToken),
    });
    expect(newStored.revokedAt).toBeNull();
    expect(newStored.familyId).toBe(oldStored.familyId);
  });

  it('rejects a request with no refresh cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .expect(401);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects an unrecognized refresh token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', ['refresh_token=not-a-real-token'])
      .expect(401);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('treats replay of an already-rotated token as theft and revokes the whole family', async () => {
    const loginCookies = await registerAndLogin('theft@refresh.e2e.test');
    const originalRefreshToken = extractCookieValue(
      loginCookies,
      'refresh_token',
    );

    const firstRotation = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', loginCookies)
      .expect(200);
    const rotatedCookies = firstRotation.headers[
      'set-cookie'
    ] as unknown as string[];

    // Replay the original (already-rotated) token — this is the theft signal.
    const replayResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${originalRefreshToken}`])
      .expect(401);
    expect((replayResponse.body as ErrorBody).error.code).toBe(
      'INVALID_REFRESH_TOKEN',
    );

    // The legitimately-rotated token from the first refresh must now be dead
    // too — the whole family was revoked, not just the replayed token.
    const secondRotation = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookies)
      .expect(401);
    expect((secondRotation.body as ErrorBody).error.code).toBe(
      'INVALID_REFRESH_TOKEN',
    );
  });

  it('rejects refresh for a suspended account with 403', async () => {
    const email = 'suspended@refresh.e2e.test';
    const loginCookies = await registerAndLogin(email);
    await users.update({ email }, { status: UserStatus.SUSPENDED });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', loginCookies)
      .expect(403);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('rejects an expired refresh token', async () => {
    const email = 'expired@refresh.e2e.test';
    await registerAndLogin(email);
    const user = await users.findOneByOrFail({ email });

    const expiredRawToken = 'expired-raw-token-value';
    await refreshTokens.save(
      refreshTokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(expiredRawToken),
        familyId: '00000000-0000-0000-0000-000000000000',
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
      }),
    );

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${expiredRawToken}`])
      .expect(401);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('clears session cookies when refresh fails', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', ['refresh_token=garbage'])
      .expect(401);

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    const accessCookie = setCookie.find((c) => c.startsWith('access_token='));
    const refreshCookie = setCookie.find((c) => c.startsWith('refresh_token='));
    expect(accessCookie).toMatch(/access_token=;/);
    expect(refreshCookie).toMatch(/refresh_token=;/);
  });
});
