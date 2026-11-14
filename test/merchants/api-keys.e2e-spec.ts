import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { AccountFlagsService } from '../../src/modules/identity/application/account-flags.service';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'api-keys.e2e.test';

interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}
interface KeyView {
  id: string;
  displayKey: string;
  state: string;
  scopes: string[];
}
interface Created {
  key: KeyView;
  secret: string;
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant API keys (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let jwt: JwtService;
  let flags: AccountFlagsService;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const code = (response: request.Response): string =>
    (response.body as ErrorBody).error.code;
  const data = <T>(response: request.Response): T =>
    (response.body as { data: T }).data;

  async function makeUser(name: string): Promise<UserEntity> {
    return users.save(
      users.create({
        email: `${name}@${DOMAIN}`,
        passwordHash: await hashPassword(PASSWORD),
        firstName: name,
        lastName: 'Tester',
        role: UserRole.CONSUMER,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
        emailVerifiedAt: new Date(),
      }),
    );
  }

  async function signIn(user: UserEntity): Promise<string[]> {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    return cookiesFrom(login);
  }

  const staleSession = (user: UserEntity): string[] => [
    `access_token=${jwt.sign({ sub: user.id, role: user.role })}`,
  ];
  // A just-confirmed session (what the 2FA sign-in step issues).
  const freshSession = (user: UserEntity): string[] => [
    `access_token=${jwt.sign({ sub: user.id, role: user.role, reauthAt: Math.floor(Date.now() / 1000) })}`,
  ];

  const as = (cookies: string[]) => ({
    get: (url: string) => http().get(`/api/v1${url}`).set('Cookie', cookies),
    post: (url: string, body: object = {}) =>
      http()
        .post(`/api/v1${url}`)
        .set('Cookie', cookies)
        .set('X-Locoomo-Client', 'web')
        .send(body),
    patch: (url: string, body: object = {}) =>
      http()
        .patch(`/api/v1${url}`)
        .set('Cookie', cookies)
        .set('X-Locoomo-Client', 'web')
        .send(body),
  });

  const ping = (key: string) =>
    http().get('/api/v1/merchant/ping').set('Authorization', `Bearer ${key}`);

  async function merchantFor(
    owner: UserEntity,
  ): Promise<{ cookies: string[]; merchantId: string }> {
    const cookies = await signIn(owner);
    const created = data<{ merchant: { id: string } }>(
      await as(cookies)
        .post('/merchant/account', { type: 'business', tradingName: 'Keys' })
        .expect(201),
    );
    return { cookies, merchantId: created.merchant.id };
  }

  async function enableMfa(user: UserEntity): Promise<void> {
    await dataSource.query(
      `INSERT INTO mfa_factors ("userId", "secretSealed", "confirmedAt") VALUES ($1, 'x', now())`,
      [user.id],
    );
    await flags.bust(user.id);
  }

  async function approve(merchantId: string): Promise<void> {
    await dataSource.query(
      `UPDATE merchants SET status = 'approved', tier = 'business', "approvedAt" = now() WHERE id = $1`,
      [merchantId],
    );
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    // One real listener: concurrent requests (rate-limit test) then share it.
    await app.listen(0);
    users = moduleFixture.get(getRepositoryToken(UserEntity));
    dataSource = moduleFixture.get(DataSource);
    jwt = moduleFixture.get(JwtService);
    flags = moduleFixture.get(AccountFlagsService);
  });

  afterAll(async () => {
    try {
      const pattern = `%@${DOMAIN}`;
      const owned = `SELECT m.id FROM merchants m JOIN users u ON u.id = m."createdByUserId" WHERE u.email LIKE $1`;
      await dataSource.query(
        `DELETE FROM merchant_api_requests WHERE "merchantId" IN (${owned})`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM audit_events WHERE "merchantId" IN (${owned}) OR "actorId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM merchants WHERE "createdByUserId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(`DELETE FROM users WHERE email LIKE $1`, [
        pattern,
      ]);
    } finally {
      await app.close();
    }
  });

  it('issues test keys before approval, shows the secret once, and authenticates with it', async () => {
    const owner = await makeUser('test-keys');
    const { cookies, merchantId } = await merchantFor(owner);

    const created = data<Created>(
      await as(cookies)
        .post('/merchant/api-keys', {
          mode: 'test',
          kind: 'secret',
          name: 'Staging server',
        })
        .expect(201),
    );
    expect(created.secret).toMatch(/^sk_test_[A-Za-z0-9]{43}$/);
    expect(created.key.displayKey).toBe(`sk_test_…${created.secret.slice(-4)}`);
    expect(created.key.scopes).not.toContain('webhooks:manage');

    const listed = data<KeyView[]>(
      await as(cookies).get('/merchant/api-keys?mode=test').expect(200),
    );
    expect(JSON.stringify(listed)).not.toContain(created.secret);

    const ok = await ping(created.secret).expect(200);
    const who = data<{ scopes: string[] }>(ok);
    expect(who).toMatchObject({ merchantId, mode: 'test', keyKind: 'secret' });
    expect(who.scopes).toEqual(
      expect.arrayContaining(['shipments:write', 'nodes:read']),
    );
    expect(ok.headers['x-ratelimit-limit']).toBe('25');
    expect(Number(ok.headers['x-ratelimit-remaining'])).toBeLessThan(25);

    // The request lands in the API log (written once the response finishes).
    let logs: { items: { path: string; statusCode: number }[] } = {
      items: [],
    };
    for (let i = 0; i < 20 && logs.items.length === 0; i++) {
      logs = data(await as(cookies).get('/merchant/api-logs').expect(200));
      if (logs.items.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(logs.items[0]).toMatchObject({
      path: '/api/v1/merchant/ping',
      statusCode: 200,
    });
  });

  it('rejects unknown keys, keys on other routes, keys in the URL, and sessions on key-only routes', async () => {
    const owner = await makeUser('rejections');
    const { cookies } = await merchantFor(owner);
    const { secret } = data<Created>(
      await as(cookies)
        .post('/merchant/api-keys', { mode: 'test', kind: 'secret', name: 'K' })
        .expect(201),
    );

    const unknown = await ping(`sk_test_${'x'.repeat(43)}`).expect(401);
    expect(code(unknown)).toBe('INVALID_API_KEY');
    await http()
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${secret}`)
      .expect(401);
    await http().get(`/api/v1/merchant/ping?key=${secret}`).expect(401);
    await as(cookies).get('/merchant/ping').expect(401);
  });

  it('gates live keys on approval, 2FA for caller and owner, and step-up', async () => {
    const owner = await makeUser('live-owner');
    const { merchantId } = await merchantFor(owner);
    const body = { mode: 'live', kind: 'secret', name: 'Production' };

    const stale = await as(staleSession(owner))
      .post('/merchant/api-keys', body)
      .expect(403);
    expect(code(stale)).toBe('REAUTH_REQUIRED');

    const fresh = await signIn(owner);
    const noMfa = await as(fresh).post('/merchant/api-keys', body).expect(403);
    expect(code(noMfa)).toBe('MFA_REQUIRED_FOR_LIVE_KEYS');
    expect((noMfa.body as ErrorBody).error.details).toEqual({ who: 'you' });

    await enableMfa(owner);
    const draft = await as(fresh).post('/merchant/api-keys', body).expect(403);
    expect(code(draft)).toBe('MERCHANT_NOT_APPROVED');

    await approve(merchantId);
    const live = data<Created>(
      await as(fresh).post('/merchant/api-keys', body).expect(201),
    );
    expect(live.secret.startsWith('sk_live_')).toBe(true);
    const pinged = await ping(live.secret).expect(200);
    expect(data<{ mode: string }>(pinged).mode).toBe('live');
    expect(pinged.headers['x-ratelimit-limit']).toBe('3000');
  });

  it('needs the owner’s 2FA too when someone else creates a live key', async () => {
    const owner = await makeUser('owner-no-mfa');
    const developer = await makeUser('developer');
    const { cookies, merchantId } = await merchantFor(owner);
    await approve(merchantId);
    await dataSource.query(
      `INSERT INTO merchant_members ("merchantId", "userId", role) VALUES ($1, $2, 'developer')`,
      [merchantId, developer.id],
    );
    await enableMfa(developer);
    const devCookies = freshSession(developer);
    const response = await as(devCookies)
      .post('/merchant/api-keys', { mode: 'live', kind: 'secret', name: 'P' })
      .expect(403);
    expect((response.body as ErrorBody).error.details).toEqual({
      who: 'owner',
    });

    // Viewers can't manage keys at all.
    const viewer = await makeUser('viewer');
    await dataSource.query(
      `INSERT INTO merchant_members ("merchantId", "userId", role) VALUES ($1, $2, 'viewer')`,
      [merchantId, viewer.id],
    );
    const denied = await as(await signIn(viewer))
      .get('/merchant/api-keys')
      .expect(403);
    expect(code(denied)).toBe('MERCHANT_PERMISSION_DENIED');
    expect(cookies).toBeDefined();
  });

  it('rolls with an overlap, rolls immediately, revokes, and revokes all', async () => {
    const owner = await makeUser('rotation');
    const { cookies } = await merchantFor(owner);
    const first = data<Created>(
      await as(cookies)
        .post('/merchant/api-keys', { mode: 'test', kind: 'secret', name: 'A' })
        .expect(201),
    );

    const rolled = data<Created>(
      await as(cookies)
        .post(`/merchant/api-keys/${first.key.id}/roll`, { expireOldIn: '1h' })
        .expect(201),
    );
    await ping(first.secret).expect(200);
    await ping(rolled.secret).expect(200);
    const listed = data<KeyView[]>(
      await as(cookies).get('/merchant/api-keys').expect(200),
    );
    expect(listed.find((k) => k.id === first.key.id)?.state).toBe('expiring');

    const again = data<Created>(
      await as(cookies)
        .post(`/merchant/api-keys/${rolled.key.id}/roll`, {
          expireOldIn: 'now',
        })
        .expect(201),
    );
    await ping(rolled.secret).expect(401);
    await ping(again.secret).expect(200);

    await as(cookies)
      .post(`/merchant/api-keys/${again.key.id}/revoke`)
      .expect(200);
    await ping(again.secret).expect(401);
    const revokedRoll = await as(cookies)
      .post(`/merchant/api-keys/${again.key.id}/roll`, { expireOldIn: 'now' })
      .expect(409);
    expect(code(revokedRoll)).toBe('API_KEY_REVOKED');

    const extra = data<Created>(
      await as(cookies)
        .post('/merchant/api-keys', {
          mode: 'test',
          kind: 'publishable',
          name: 'Checkout',
        })
        .expect(201),
    );
    const all = data<{ revoked: number }>(
      await as(cookies)
        .post('/merchant/api-keys/revoke-all', { mode: 'test' })
        .expect(200),
    );
    expect(all.revoked).toBe(2); // the first key (expiring) and the pk
    await ping(first.secret).expect(401);
    await ping(extra.secret).expect(401);
  });

  it('enforces IP and origin allow-lists, with open CORS for publishable keys', async () => {
    const owner = await makeUser('restrictions');
    const { cookies } = await merchantFor(owner);

    const ipLocked = data<Created>(
      await as(cookies)
        .post('/merchant/api-keys', {
          mode: 'test',
          kind: 'secret',
          name: 'Locked',
          allowedIps: ['203.0.113.0/24'],
        })
        .expect(201),
    );
    await ping(ipLocked.secret).expect(401);
    await as(cookies)
      .patch(`/merchant/api-keys/${ipLocked.key.id}`, {
        allowedIps: ['127.0.0.1', '::1'],
      })
      .expect(200);
    await ping(ipLocked.secret).expect(200);

    const badCidr = await as(cookies)
      .post('/merchant/api-keys', {
        mode: 'test',
        kind: 'secret',
        name: 'Bad',
        allowedIps: ['10.0.0.0/99'],
      })
      .expect(400);
    expect(code(badCidr)).toBe('VALIDATION_FAILED');

    const pk = data<Created>(
      await as(cookies)
        .post('/merchant/api-keys', {
          mode: 'test',
          kind: 'publishable',
          name: 'Checkout',
          allowedOrigins: ['https://shop.example.com'],
        })
        .expect(201),
    );
    expect(pk.secret.startsWith('pk_test_')).toBe(true);

    const preflight = await http()
      .options('/api/v1/merchant/ping')
      .set('Origin', 'https://shop.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'https://shop.example.com',
    );
    expect(
      preflight.headers['access-control-allow-credentials'],
    ).toBeUndefined();

    const allowed = await ping(pk.secret)
      .set('Origin', 'https://shop.example.com')
      .expect(200);
    expect(data<{ scopes: string[] }>(allowed).scopes).toEqual([
      'nodes:read',
      'quotes:read',
    ]);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://shop.example.com',
    );
    await ping(pk.secret).set('Origin', 'https://evil.example').expect(401);

    // Dashboard routes keep the credentialed, allow-listed CORS.
    const dashboard = await http()
      .options('/api/v1/merchant/api-keys')
      .set('Origin', 'https://shop.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(dashboard.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate-limits per key with Retry-After', async () => {
    const owner = await makeUser('rate-limit');
    const { cookies } = await merchantFor(owner);
    const { secret } = data<Created>(
      await as(cookies)
        .post('/merchant/api-keys', { mode: 'test', kind: 'secret', name: 'R' })
        .expect(201),
    );
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => ping(secret)),
    );
    const limited = responses.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(code(limited[0])).toBe('RATE_LIMITED');
    expect(Number(limited[0].headers['retry-after'])).toBeGreaterThan(0);
  });
});
