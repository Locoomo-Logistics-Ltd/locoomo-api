import crypto, { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { AdminPermission } from '../../src/common/auth/admin-permission.enum';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { ApiRateLimiter } from '../../src/modules/merchants/application/api-rate-limiter';
import { WebhookDispatcherService } from '../../src/modules/merchants/application/webhook-dispatcher.service';
import {
  WebhookResponse,
  WebhookTransport,
} from '../../src/modules/merchants/infrastructure/webhook-transport';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'webhooks.e2e.test';
const NODE_PREFIX = 'MWHK-';

interface WebhookBody {
  id: string;
  type: string;
  version: number;
  mode: string;
  data: {
    shipment: { id: string; status: string };
    sequence: number;
    collectionCode?: string;
    merchant?: { id: string; status: string; previousStatus: string };
  };
}

interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}

class FakeTransport extends WebhookTransport {
  sent: Sent[] = [];
  statusFor = new Map<string, number>();

  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<WebhookResponse> {
    this.sent.push({ url, body, headers });
    const status = this.statusFor.get(url) ?? 200;
    return Promise.resolve({
      status,
      body: status < 300 ? 'ok' : 'nope',
      error: null,
      durationMs: 3,
    });
  }

  to(url: string): (Sent & { event: WebhookBody })[] {
    return this.sent
      .filter((s) => s.url === url)
      .map((s) => ({ ...s, event: JSON.parse(s.body) as WebhookBody }));
  }
}

// MERCHANT_API.md §12.3, Node.js snippet, verbatim logic.
function verifyLocoomoWebhook(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
): boolean {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = String(headers['webhook-signature'] || '');
  if (!id || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');
  return signatures.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return (
      version === 'v1' &&
      !!sig &&
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    );
  });
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant webhooks (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let dispatcher: WebhookDispatcherService;
  let jwt: JwtService;
  const transport = new FakeTransport();
  let owner: UserEntity;
  let ownerCookies: string[];
  let adminCookies: string[];
  let merchantId: string;
  let key: string;
  let plainKey: string;
  const node = { origin: '', home: '' };

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const code = (r: request.Response): string =>
    (r.body as { error: { code: string } }).error.code;
  const data = <T>(r: request.Response): T => (r.body as { data: T }).data;
  const api = (k: string) => ({
    get: (url: string) =>
      http().get(`/api/v1/merchant${url}`).set('Authorization', `Bearer ${k}`),
    post: (url: string, body: object = {}) =>
      http()
        .post(`/api/v1/merchant${url}`)
        .set('Authorization', `Bearer ${k}`)
        .send(body),
    patch: (url: string, body: object) =>
      http()
        .patch(`/api/v1/merchant${url}`)
        .set('Authorization', `Bearer ${k}`)
        .send(body),
  });

  async function makeUser(name: string, overrides: Partial<UserEntity> = {}) {
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
        ...overrides,
      }),
    );
  }

  async function signIn(user: UserEntity): Promise<string[]> {
    return cookiesFrom(
      await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200),
    );
  }

  async function addEndpoint(url: string, events?: string[]) {
    return data<{ endpoint: { id: string }; secret: string }>(
      await api(key)
        .post('/webhook-endpoints', { url, ...(events && { events }) })
        .expect(201),
    );
  }

  async function createShipment(overrides: Record<string, unknown> = {}) {
    return data<{ id: string }>(
      await api(key)
        .post('/shipments', {
          reference: `R-${randomUUID()}`,
          destinationNodeId: node.home,
          origin: { type: 'node', nodeId: node.origin },
          receiver: {
            name: 'Chioma Okafor',
            phone: '08031234567',
            email: 'c@example.com',
          },
          parcel: { description: 'Earbuds', size: 'small' },
          ...overrides,
        })
        .expect(201),
    );
  }

  const drain = async (): Promise<void> => {
    while ((await dispatcher.dispatchDue()) > 0) {
      // until nothing is due
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WebhookTransport)
      .useValue(transport)
      .overrideProvider(ApiRateLimiter)
      .useValue({
        consume: () =>
          Promise.resolve({
            allowed: true,
            limit: 1000,
            remaining: 999,
            resetSeconds: 1,
            retryAfterSeconds: 1,
          }),
        failedAttempt: () => Promise.resolve(false),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    users = moduleFixture.get(getRepositoryToken(UserEntity));
    dataSource = moduleFixture.get(DataSource);
    dispatcher = moduleFixture.get(WebhookDispatcherService);
    jwt = moduleFixture.get(JwtService);

    adminCookies = await signIn(
      await makeUser('admin', {
        role: UserRole.ADMIN,
        adminPermissions: [AdminPermission.SUPER],
      }),
    );
    await http()
      .post('/api/v1/admin/pricing')
      .set('Cookie', adminCookies)
      .send({ baseFeeNaira: 500, perKmRateNaira: 100, destinationFeeNaira: 50 })
      .expect(201);
    for (const [name, offset] of [
      ['origin', 0],
      ['home', 2],
    ] as const) {
      node[name] = data<{ id: string }>(
        await http()
          .post('/api/v1/nodes')
          .set('Cookie', adminCookies)
          .send({
            name: `${NODE_PREFIX}${name}`,
            address: `${name} road`,
            city: 'Enugu',
            state: 'Enugu',
            latitude: 6.44 + offset / 111,
            longitude: 7.5,
            capacity: 10,
            ...NODE_CONTACT_FIELDS,
          })
          .expect(201),
      ).id;
    }

    owner = await makeUser('owner');
    ownerCookies = await signIn(owner);
    merchantId = data<{ merchant: { id: string } }>(
      await http()
        .post('/api/v1/merchant/account')
        .set('Cookie', ownerCookies)
        .send({ type: 'business', tradingName: 'Hooks' })
        .expect(201),
    ).merchant.id;
    const keyFor = async (scopes?: string[]) =>
      data<{ secret: string }>(
        await http()
          .post('/api/v1/merchant/api-keys')
          .set('Cookie', ownerCookies)
          .send({
            mode: 'test',
            kind: 'secret',
            name: 'k',
            ...(scopes && { scopes }),
          })
          .expect(201),
      ).secret;
    key = await keyFor([
      'shipments:read',
      'shipments:write',
      'webhooks:manage',
    ]);
    plainKey = await keyFor();
  });

  // Each test sets up its own endpoints (5 per mode at most).
  afterEach(async () => {
    await dataSource.query(
      `DELETE FROM webhook_endpoints WHERE "merchantId" = $1`,
      [merchantId],
    );
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
        `DELETE FROM idempotency_keys WHERE scope IN (SELECT 'http:merchant:' || id || ':test' FROM (${owned}) m)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM audit_events WHERE "merchantId" IN (${owned}) OR "actorId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM outbox_events WHERE payload->>'to' LIKE $1`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM merchants WHERE "createdByUserId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM pricing_rules WHERE "createdByAdminId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(`DELETE FROM nodes WHERE name LIKE $1`, [
        `${NODE_PREFIX}%`,
      ]);
      await dataSource.query(`DELETE FROM users WHERE email LIKE $1`, [
        pattern,
      ]);
    } finally {
      await app.close();
    }
  });

  it('manages endpoints only with webhooks:manage, public HTTPS URLs and at most 5', async () => {
    expect(
      code(await api(plainKey).get('/webhook-endpoints').expect(403)),
    ).toBe('INSUFFICIENT_SCOPE');
    for (const url of [
      'http://hooks.example.com/x',
      'https://10.0.0.1/x',
      'https://localhost/x',
    ]) {
      expect(
        code(await api(key).post('/webhook-endpoints', { url }).expect(422)),
      ).toBe('INVALID_WEBHOOK_URL');
    }
    const { secret } = await addEndpoint('https://limit-1.example.com/hook');
    expect(secret).toMatch(/^whsec_/);
    for (let i = 2; i <= 5; i++) {
      await addEndpoint(`https://limit-${i}.example.com/hook`);
    }
    expect(
      code(
        await api(key)
          .post('/webhook-endpoints', {
            url: 'https://limit-6.example.com/hook',
          })
          .expect(409),
      ),
    ).toBe('WEBHOOK_ENDPOINT_LIMIT_REACHED');
    const list = data<{ id: string; url: string }[]>(
      await api(key).get('/webhook-endpoints').expect(200),
    );
    expect(JSON.stringify(list)).not.toContain(secret);
    await dataSource.query(
      `DELETE FROM webhook_endpoints WHERE url LIKE 'https://limit-%'`,
    );
  });

  it('delivers every step in order, signed per Standard Webhooks, with the whole shipment', async () => {
    const all = 'https://all.example.com/hook';
    const collectedOnly = 'https://collected.example.com/hook';
    const { secret } = await addEndpoint(all);
    await addEndpoint(collectedOnly, ['shipment.collected']);

    const shipment = await createShipment();
    await api(key)
      .post(`/test/shipments/${shipment.id}/simulate`, { to: 'collected' })
      .expect(200);
    await drain();

    // Up to 4 in flight per endpoint: arrival order isn't guaranteed
    // (integrators order by sequence, §12.4).
    const received = transport
      .to(all)
      .filter((s) => s.event.data?.shipment?.id === shipment.id)
      .sort((a, b) => a.event.data.sequence - b.event.data.sequence);
    expect(received.map((s) => [s.event.type, s.event.data.sequence])).toEqual([
      ['shipment.created', 1],
      ['shipment.received', 2],
      ['shipment.in_transit', 3],
      ['shipment.ready_for_collection', 4],
      ['shipment.collected', 5],
    ]);
    for (const s of received) {
      expect(verifyLocoomoWebhook(s.body, s.headers, secret)).toBe(true);
      expect(s.headers['webhook-id']).toBe(s.event.id);
      expect(s.event).toMatchObject({ version: 1, mode: 'test' });
    }
    expect(received[4].event.data.shipment.status).toBe('collected');
    expect(received[4].event.data.collectionCode).toBeUndefined();
    expect(
      verifyLocoomoWebhook(
        received[0].body.replace('created', 'Created'),
        received[0].headers,
        secret,
      ),
    ).toBe(false);

    const filtered = transport
      .to(collectedOnly)
      .filter((s) => s.event.data?.shipment?.id === shipment.id);
    expect(filtered.map((s) => s.event.type)).toEqual(['shipment.collected']);
  });

  it('includes the collection code only when the merchant relays it, never on the shipment', async () => {
    await dataSource.query(
      `UPDATE merchants SET "receiverCodeRelay" = true WHERE id = $1`,
      [merchantId],
    );
    const url = 'https://relay.example.com/hook';
    await addEndpoint(url, ['shipment.ready_for_collection']);
    const shipment = await createShipment({
      notifyReceiver: 'merchant',
      receiver: { name: 'No Email', phone: '08031234567' },
    });
    await api(key)
      .post(`/test/shipments/${shipment.id}/simulate`, {
        to: 'ready_for_collection',
      })
      .expect(200);
    await drain();
    const [event] = transport
      .to(url)
      .filter((s) => s.event.data.shipment.id === shipment.id);
    expect(event.event.data.collectionCode).toMatch(/^\d{6}$/);
    const read = await api(key).get(`/shipments/${shipment.id}`).expect(200);
    expect(JSON.stringify(read.body)).not.toContain(
      event.event.data.collectionCode,
    );
  });

  it('retries failures on schedule and disables an endpoint failing for 36 hours', async () => {
    const url = 'https://down.example.com/hook';
    transport.statusFor.set(url, 500);
    const { endpoint } = await addEndpoint(url, ['shipment.created']);
    await createShipment();
    await drain();

    const [first] = await dataSource.query<
      { id: string; status: string; attempts: number; wait: number }[]
    >(
      `SELECT id, status, attempts, EXTRACT(EPOCH FROM ("nextAttemptAt" - now()))::float AS wait
         FROM webhook_deliveries WHERE "endpointId" = $1`,
      [endpoint.id],
    );
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });
    expect(first.wait).toBeGreaterThan(2);
    expect(first.wait).toBeLessThanOrEqual(5);

    // 36 hours of failures later…
    await dataSource.query(
      `UPDATE webhook_deliveries SET "nextAttemptAt" = now() WHERE id = $1`,
      [first.id],
    );
    await dataSource.query(
      `UPDATE webhook_endpoints SET "failingSince" = now() - interval '37 hours' WHERE id = $1`,
      [endpoint.id],
    );
    await drain();
    const endpoints = data<
      { id: string; enabled: boolean; disabledReason: string }[]
    >(await api(key).get('/webhook-endpoints').expect(200));
    expect(endpoints.find((e) => e.id === endpoint.id)).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining('36 hours') as string,
    });
    const [email] = await dataSource.query<{ subject: string }[]>(
      `SELECT payload->>'subject' AS subject FROM outbox_events WHERE payload->>'to' = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [owner.email],
    );
    expect(email.subject).toBe('A Locoomo webhook endpoint was disabled');

    // Disabled endpoints get nothing until re-enabled.
    const before = transport.to(url).length;
    await createShipment();
    await drain();
    expect(transport.to(url).length).toBe(before);
    transport.statusFor.delete(url);
    await api(key)
      .patch(`/webhook-endpoints/${endpoint.id}`, { enabled: true })
      .expect(200);
    const replay = data<{ queued: number }>(
      await api(key)
        .post(`/webhook-endpoints/${endpoint.id}/replay`, {
          since: new Date(Date.now() - 60_000).toISOString(),
        })
        .expect(200),
    );
    expect(replay.queued).toBeGreaterThanOrEqual(2);
    await drain();
    expect(transport.to(url).length).toBeGreaterThan(before);
  });

  it('sends a test event on demand and logs every delivery', async () => {
    const url = 'https://tester.example.com/hook';
    const { endpoint } = await addEndpoint(url);
    const ok = data<{ delivered: boolean; responseStatus: number }>(
      await api(key).post(`/webhook-endpoints/${endpoint.id}/test`).expect(200),
    );
    expect(ok).toMatchObject({ delivered: true, responseStatus: 200 });
    expect(transport.to(url).at(-1)?.event.type).toBe('webhook.test');

    transport.statusFor.set(url, 404);
    const failed = data<{ delivered: boolean; responseStatus: number }>(
      await api(key).post(`/webhook-endpoints/${endpoint.id}/test`).expect(200),
    );
    expect(failed).toMatchObject({ delivered: false, responseStatus: 404 });
    transport.statusFor.delete(url);

    const log = data<{
      items: { eventType: string; status: string; responseStatus: number }[];
    }>(
      await api(key)
        .get(`/webhook-deliveries?endpointId=${endpoint.id}&limit=2`)
        .expect(200),
    );
    expect(log.items.map((d) => [d.eventType, d.responseStatus])).toEqual([
      ['webhook.test', 404],
      ['webhook.test', 200],
    ]);
  });

  it('signs with both secrets for a day after a roll', async () => {
    const url = 'https://rolled.example.com/hook';
    const { endpoint, secret: oldSecret } = await addEndpoint(url, [
      'shipment.created',
    ]);
    const { secret: newSecret } = data<{ secret: string }>(
      await api(key)
        .post(`/webhook-endpoints/${endpoint.id}/roll-secret`)
        .expect(200),
    );
    await createShipment();
    await drain();
    const last = transport.to(url).at(-1)!;
    expect(last.headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(verifyLocoomoWebhook(last.body, last.headers, oldSecret)).toBe(true);
    expect(verifyLocoomoWebhook(last.body, last.headers, newSecret)).toBe(true);
  });

  it('announces account status changes, and asks dashboard users to confirm URL changes', async () => {
    const url = 'https://status.example.com/hook';
    const { endpoint } = await addEndpoint(url, ['merchant.status_changed']);
    await http()
      .post(`/api/v1/admin/merchants/${merchantId}/suspend`)
      .set('Cookie', adminCookies)
      .send({ reason: 'Testing' })
      .expect(200);
    await drain();
    expect(transport.to(url).at(-1)?.event).toMatchObject({
      type: 'merchant.status_changed',
      data: {
        merchant: {
          id: merchantId,
          status: 'suspended',
          previousStatus: 'draft',
        },
      },
    });
    await http()
      .post(`/api/v1/admin/merchants/${merchantId}/reinstate`)
      .set('Cookie', adminCookies)
      .expect(200);

    const stale = [
      `access_token=${jwt.sign({ sub: owner.id, role: owner.role })}`,
    ];
    const refused = await http()
      .patch(`/api/v1/merchant/webhook-endpoints/${endpoint.id}`)
      .set('Cookie', stale)
      .send({ url: 'https://elsewhere.example.com/hook' })
      .expect(403);
    expect(code(refused)).toBe('REAUTH_REQUIRED');
    await http()
      .patch(`/api/v1/merchant/webhook-endpoints/${endpoint.id}`)
      .set('Cookie', ownerCookies)
      .send({ url: 'https://elsewhere.example.com/hook' })
      .expect(200);
  });
});
