import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { hashRefreshToken } from '../../src/modules/identity/domain/refresh-token-hasher';
import { RefreshTokenEntity } from '../../src/modules/identity/infrastructure/entities/refresh-token.entity';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

function extractCookieValue(setCookie: string[], name: string): string {
  const cookie = setCookie.find((c) => c.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`${name} cookie not found in Set-Cookie headers`);
  }
  return cookie.split(';')[0].split('=')[1];
}

describe('POST /api/v1/auth/logout (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let refreshTokens: Repository<RefreshTokenEntity>;

  const emailPattern = '%@logout.e2e.test';
  const password = 'Correct-Horse-Battery-1';

  async function registerAndLogin(email: string): Promise<string[]> {
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Logout',
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

  it('revokes the current refresh token and clears both cookies', async () => {
    const loginCookies = await registerAndLogin('basic@logout.e2e.test');
    const refreshToken = extractCookieValue(loginCookies, 'refresh_token');

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', loginCookies)
      .expect(200);

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    const accessCookie = setCookie.find((c) => c.startsWith('access_token='));
    const refreshCookie = setCookie.find((c) => c.startsWith('refresh_token='));
    expect(accessCookie).toMatch(/access_token=;/);
    expect(refreshCookie).toMatch(/refresh_token=;/);

    const stored = await refreshTokens.findOneByOrFail({
      tokenHash: hashRefreshToken(refreshToken),
    });
    expect(stored.revokedAt).not.toBeNull();
  });

  it('rejects reusing a refresh token after logout, same as any other revoked token', async () => {
    const loginCookies = await registerAndLogin('reuse@logout.e2e.test');

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', loginCookies)
      .expect(200);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', loginCookies)
      .expect(401);

    expect((response.body as { error: { code: string } }).error.code).toBe(
      'INVALID_REFRESH_TOKEN',
    );
  });

  it('does not revoke other sessions for the same user', async () => {
    const email = 'multisession@logout.e2e.test';
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({
      firstName: 'Multi',
      lastName: 'Session',
      email,
      phone: '+2348012345678',
      password,
      passwordConfirmation: password,
      consentAccepted: true,
    });

    const sessionA = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200)
    ).headers['set-cookie'] as unknown as string[];

    const sessionB = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200)
    ).headers['set-cookie'] as unknown as string[];

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', sessionA)
      .expect(200);

    // Session B never touched logout — it must still work.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', sessionB)
      .expect(200);
  });

  it('is idempotent — no session cookie at all still returns 200', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(200);
  });

  it('is idempotent — a garbage refresh cookie still returns 200', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', ['refresh_token=not-a-real-token'])
      .expect(200);
  });
});
