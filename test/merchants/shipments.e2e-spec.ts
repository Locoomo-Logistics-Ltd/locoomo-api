import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
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
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'shipments.e2e.test';
const NODE_PREFIX = 'MSHP-';
const CENTRE = { latitude: 7.38, longitude: 3.9 }; // Ibadan: our Nodes only

interface ErrorBody {
  error: { code: string; details?: unknown };
}
interface Shipment {
  id: string;
  mode: string;
  reference: string;
  trackingCode: string;
  trackingUrl: string | null;
  status: string;
  sequence: number;
  origin: { type: string; nodeId: string; nodeName: string };
  destination: { nodeId: string; nodeName: string; changed: boolean };
  receiver: { name: string; phone: string; email: string | null };
  parcel: { measured: { weightKg: number } | null };
  fee: {
    quotedKobo: number;
    chargedKobo: number | null;
    state: string;
    breakdown: { baseKobo: number; distanceKobo: number };
  };
  collection: {
    deadline: string | null;
    collectedAt: string | null;
    method: string | null;
  };
  return: { reason: string; readyForCollectionAt: string | null } | null;
  exception: { type: string } | null;
  metadata: Record<string, string>;
}
interface Page {
  items: Shipment[];
  nextCursor: string | null;
  hasMore: boolean;
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant shipments, test mode (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let ownerCookies: string[];
  let key: string;
  let readOnlyKey: string;
  let checkoutKey: string;
  let otherMerchantKey: string;
  const node = { origin: '', home: '', office: '', hidden: '' };

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const code = (response: request.Response): string =>
    (response.body as ErrorBody).error.code;
  const details = <T>(response: request.Response): T =>
    (response.body as ErrorBody).error.details as T;
  const data = <T>(response: request.Response): T =>
    (response.body as { data: T }).data;

  const api = (k: string) => ({
    get: (url: string) =>
      http().get(`/api/v1/merchant${url}`).set('Authorization', `Bearer ${k}`),
    post: (url: string, body: object = {}, idempotencyKey?: string) => {
      const req = http()
        .post(`/api/v1/merchant${url}`)
        .set('Authorization', `Bearer ${k}`);
      if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
      return req.send(body);
    },
    patch: (url: string, body: object) =>
      http()
        .patch(`/api/v1/merchant${url}`)
        .set('Authorization', `Bearer ${k}`)
        .send(body),
  });

  let counter = 0;
  const shipmentBody = (overrides: Record<string, unknown> = {}) => ({
    reference: `ORD-${++counter}-${randomUUID().slice(0, 6)}`,
    destinationNodeId: node.home,
    origin: { type: 'node', nodeId: node.origin },
    receiver: {
      name: 'Chioma Okafor',
      phone: '0803 123 4567',
      email: 'chioma@example.com',
    },
    parcel: { description: 'Wireless earbuds', size: 'small', weightKg: 0.4 },
    metadata: { orderId: '88412' },
    ...overrides,
  });

  async function create(overrides: Record<string, unknown> = {}) {
    return data<Shipment>(
      await api(key).post('/shipments', shipmentBody(overrides)).expect(201),
    );
  }

  const simulate = (id: string, body: object) =>
    api(key).post(`/test/shipments/${id}/simulate`, body);

  async function makeUser(
    name: string,
    overrides: Partial<UserEntity> = {},
  ): Promise<UserEntity> {
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

  async function createNode(admin: string[], name: string, offsetKm: number) {
    const response = await http()
      .post('/api/v1/nodes')
      .set('Cookie', admin)
      .send({
        name: `${NODE_PREFIX}${name}`,
        address: `${name} road`,
        city: 'Ibadan',
        state: 'Oyo',
        latitude: CENTRE.latitude + offsetKm / 111,
        longitude: CENTRE.longitude,
        capacity: 10,
        ...NODE_CONTACT_FIELDS,
      })
      .expect(201);
    return data<{ id: string }>(response).id;
  }

  async function merchantWithKeys(
    cookies: string[],
    name: string,
  ): Promise<void> {
    await http()
      .post('/api/v1/merchant/account')
      .set('Cookie', cookies)
      .send({ type: 'business', tradingName: name })
      .expect(201);
  }

  async function newKey(cookies: string[], body: object): Promise<string> {
    return data<{ secret: string }>(
      await http()
        .post('/api/v1/merchant/api-keys')
        .set('Cookie', cookies)
        .send({ mode: 'test', name: 'k', ...body })
        .expect(201),
    ).secret;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Per-key rate limits have their own suite (api-keys); this one fires
      // far more than 25 requests a second with one test key.
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

    const admin = await signIn(
      await makeUser('admin', {
        role: UserRole.ADMIN,
        adminPermissions: [AdminPermission.SUPER],
      }),
    );
    await http()
      .post('/api/v1/admin/pricing')
      .set('Cookie', admin)
      .send({ baseFeeNaira: 500, perKmRateNaira: 100, destinationFeeNaira: 50 })
      .expect(201);
    node.origin = await createNode(admin, 'Origin', 0);
    node.home = await createNode(admin, 'Home', 2);
    node.office = await createNode(admin, 'Office', 4);
    node.hidden = await createNode(admin, 'Hidden', 3);
    await dataSource.query(
      `UPDATE nodes SET "isPubliclyVisible" = false WHERE id = $1`,
      [node.hidden],
    );

    ownerCookies = await signIn(await makeUser('owner'));
    await merchantWithKeys(ownerCookies, 'Ada Stores');
    key = await newKey(ownerCookies, { kind: 'secret' });
    readOnlyKey = await newKey(ownerCookies, {
      kind: 'secret',
      scopes: ['shipments:read'],
    });
    checkoutKey = await newKey(ownerCookies, { kind: 'publishable' });

    const other = await signIn(await makeUser('other'));
    await merchantWithKeys(other, 'Other');
    otherMerchantKey = await newKey(other, { kind: 'secret' });
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
        `DELETE FROM idempotency_keys WHERE scope IN (SELECT 'http:merchant:' || m.id || ':test' FROM merchants m JOIN users u ON u.id = m."createdByUserId" WHERE u.email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM audit_events WHERE "actorId" IN (SELECT id FROM users WHERE email LIKE $1)`,
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

  describe('create', () => {
    it('creates a test shipment with a held fee, an LCT code and normalised receiver', async () => {
      const shipment = await create();
      expect(shipment).toMatchObject({
        mode: 'test',
        status: 'created',
        sequence: 1,
        trackingUrl: null,
        origin: {
          type: 'node',
          nodeId: node.origin,
          nodeName: `${NODE_PREFIX}Origin`,
        },
        destination: { nodeId: node.home, changed: false },
        receiver: { phone: '+2348031234567', email: 'chioma@example.com' },
        metadata: { orderId: '88412' },
      });
      expect(shipment.trackingCode).toMatch(/^LCT-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(shipment.fee.state).toBe('held');
      expect(shipment.fee.quotedKobo).toBeGreaterThan(0);
      expect(shipment.fee.chargedKobo).toBeNull();
    });

    it('replays a retried request and refuses a reused reference', async () => {
      const body = shipmentBody();
      const idempotencyKey = randomUUID();
      const first = await api(key)
        .post('/shipments', body, idempotencyKey)
        .expect(201);
      const retry = await api(key)
        .post('/shipments', body, idempotencyKey)
        .expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(data<Shipment>(retry).id).toBe(data<Shipment>(first).id);

      const duplicate = await api(key).post('/shipments', body).expect(409);
      expect(code(duplicate)).toBe('DUPLICATE_REFERENCE');
      expect(details(duplicate)).toEqual({
        existingShipmentId: data<Shipment>(first).id,
      });
    });

    it.each([
      [{ origin: undefined }, 422, 'ORIGIN_REQUIRED'],
      [
        { destinationNodeId: 'b4f6cdd2-6f5e-4f5b-9f1e-8ad1a2c3d4e5' },
        422,
        'DESTINATION_NODE_UNAVAILABLE',
      ],
      [
        { receiver: { name: 'No Email', phone: '08031234567' } },
        422,
        'RECEIVER_UNREACHABLE',
      ],
      [{ notifyReceiver: 'merchant' }, 422, 'RECEIVER_RELAY_NOT_ENABLED'],
      [{ unexpected: true }, 400, 'VALIDATION_FAILED'],
    ])('rejects %j with %i %s', async (overrides, status, expected) => {
      const body = shipmentBody(overrides);
      if ('origin' in overrides && overrides.origin === undefined) {
        delete (body as Record<string, unknown>).origin;
      }
      expect(code(await api(key).post('/shipments', body).expect(status))).toBe(
        expected,
      );
    });

    it('refuses a Node that is not public, and reports nested field paths', async () => {
      expect(
        code(
          await api(key)
            .post(
              '/shipments',
              shipmentBody({ destinationNodeId: node.hidden }),
            )
            .expect(422),
        ),
      ).toBe('DESTINATION_NODE_UNAVAILABLE');
      const invalid = await api(key)
        .post(
          '/shipments',
          shipmentBody({
            receiver: { name: 'X Y', phone: '123', email: 'x@example.com' },
            parcel: { description: 'Box', size: 'small', lengthCm: 10 },
          }),
        )
        .expect(400);
      const fields = details<{ field: string }[]>(invalid).map((d) => d.field);
      expect(fields).toEqual(
        expect.arrayContaining([
          'receiver.phone',
          'parcel.widthCm',
          'parcel.heightCm',
        ]),
      );
    });

    it('creates in bulk, each item on its own', async () => {
      const duplicateRef = (await create()).reference;
      const response = await api(key)
        .post('/shipments/bulk', {
          items: [
            shipmentBody(),
            shipmentBody({
              receiver: { name: 'Bad Phone', phone: '1', email: 'a@b.co' },
            }),
            shipmentBody({ reference: duplicateRef }),
          ],
        })
        .expect(200);
      const { results } = data<{
        results: {
          index: number;
          ok: boolean;
          shipment?: Shipment;
          error?: { code: string; details?: { field: string }[] };
        }[];
      }>(response);
      expect(results.map((r) => [r.index, r.ok])).toEqual([
        [0, true],
        [1, false],
        [2, false],
      ]);
      expect(results[0].shipment?.status).toBe('created');
      expect(results[1].error?.code).toBe('VALIDATION_FAILED');
      expect(results[1].error?.details?.[0].field).toBe(
        'items[1].receiver.phone',
      );
      expect(results[2].error?.code).toBe('DUPLICATE_REFERENCE');
    });
  });

  describe('read, list and sync', () => {
    it('finds by reference, filters, pages and syncs by updatedSince', async () => {
      const startedAt = new Date(Date.now() - 1000).toISOString();
      const a = await create();
      const b = await create();
      await api(key).post(`/shipments/${a.id}/cancel`).expect(200);

      const byRef = data<Page>(
        await api(key).get(`/shipments?reference=${b.reference}`).expect(200),
      );
      expect(byRef.items.map((s) => s.id)).toEqual([b.id]);

      const cancelled = data<Page>(
        await api(key).get('/shipments?status=cancelled').expect(200),
      );
      expect(cancelled.items.map((s) => s.id)).toContain(a.id);

      const page1 = data<Page>(
        await api(key)
          .get(`/shipments?limit=1&createdFrom=${startedAt}`)
          .expect(200),
      );
      expect(page1.items.map((s) => s.id)).toEqual([b.id]);
      expect(page1.hasMore).toBe(true);
      const page2 = data<Page>(
        await api(key)
          .get(
            `/shipments?limit=1&createdFrom=${startedAt}&cursor=${page1.nextCursor}`,
          )
          .expect(200),
      );
      expect(page2.items.map((s) => s.id)).toEqual([a.id]);

      // Sync: oldest change first, so a (cancelled after b was created) comes last.
      const synced = data<Page>(
        await api(key).get(`/shipments?updatedSince=${startedAt}`).expect(200),
      );
      const order = synced.items
        .map((s) => s.id)
        .filter((id) => id === a.id || id === b.id);
      expect(order).toEqual([b.id, a.id]);
    });

    it('keeps merchants and modes apart', async () => {
      const mine = await create();
      expect(
        code(
          await api(otherMerchantKey).get(`/shipments/${mine.id}`).expect(404),
        ),
      ).toBe('NOT_FOUND');
      await api(readOnlyKey).get(`/shipments/${mine.id}`).expect(200);
      expect(
        code(
          await api(readOnlyKey).post('/shipments', shipmentBody()).expect(403),
        ),
      ).toBe('INSUFFICIENT_SCOPE');
      expect(code(await api(checkoutKey).get('/shipments').expect(403))).toBe(
        'INSUFFICIENT_SCOPE',
      );
    });
  });

  describe('change, cancel, return', () => {
    it('edits receiver anytime before collection, route only before drop-off', async () => {
      const shipment = await create();
      const moved = data<Shipment>(
        await api(key)
          .patch(`/shipments/${shipment.id}`, {
            destinationNodeId: node.office,
            receiver: { name: 'Chioma O.' },
          })
          .expect(200),
      );
      expect(moved.destination.nodeId).toBe(node.office);
      expect(moved.receiver.name).toBe('Chioma O.');
      expect(moved.sequence).toBe(2);
      expect(moved.fee.quotedKobo).toBeGreaterThan(shipment.fee.quotedKobo);

      await simulate(shipment.id, { to: 'received' }).expect(200);
      const locked = await api(key)
        .patch(`/shipments/${shipment.id}`, {
          parcel: { description: 'Bigger', size: 'large' },
        })
        .expect(409);
      expect(code(locked)).toBe('SHIPMENT_NOT_EDITABLE');
      await api(key)
        .patch(`/shipments/${shipment.id}`, { receiver: { email: null } })
        .expect(422); // nobody left to notify (no SMS in tests)
    });

    it('cancels only before drop-off and returns to sender after', async () => {
      const shipment = await create();
      const cancelled = data<Shipment>(
        await api(key).post(`/shipments/${shipment.id}/cancel`).expect(200),
      );
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        fee: { state: 'released' },
      });
      expect(
        code(
          await api(key).post(`/shipments/${shipment.id}/cancel`).expect(409),
        ),
      ).toBe('SHIPMENT_NOT_CANCELLABLE');

      const dropped = await create();
      await simulate(dropped.id, { to: 'in_transit' }).expect(200);
      expect(
        code(
          await api(key).post(`/shipments/${dropped.id}/cancel`).expect(409),
        ),
      ).toBe('SHIPMENT_NOT_CANCELLABLE');
      const returning = data<Shipment>(
        await api(key)
          .post(`/shipments/${dropped.id}/return-to-sender`)
          .expect(200),
      );
      expect(returning).toMatchObject({
        status: 'returning',
        return: { reason: 'merchant_request', readyForCollectionAt: null },
      });
      expect(
        code(
          await api(key)
            .post(`/shipments/${dropped.id}/return-to-sender`)
            .expect(409),
        ),
      ).toBe('SHIPMENT_NOT_RETURNABLE');
    });
  });

  describe('simulator', () => {
    it('walks to collected through every step, charging the fee and recording the timeline', async () => {
      const shipment = await create();
      const collected = data<Shipment>(
        await simulate(shipment.id, { to: 'collected' }).expect(200),
      );
      expect(collected).toMatchObject({
        status: 'collected',
        sequence: 5,
        fee: { state: 'charged', chargedKobo: shipment.fee.quotedKobo },
        collection: { method: 'code' },
      });
      expect(collected.collection.deadline).not.toBeNull();
      expect(collected.collection.collectedAt).not.toBeNull();

      const timeline = data<
        { type: string; nodeName: string | null; sequence: number }[]
      >(await api(key).get(`/shipments/${shipment.id}/timeline`).expect(200));
      expect(timeline.map((e) => [e.type, e.sequence])).toEqual([
        ['created', 1],
        ['received', 2],
        ['in_transit', 3],
        ['ready_for_collection', 4],
        ['collected', 5],
      ]);
      expect(timeline[1].nodeName).toBe(`${NODE_PREFIX}Origin`);
      expect(timeline[3].nodeName).toBe(`${NODE_PREFIX}Home`);

      expect(
        code(await simulate(shipment.id, { to: 'returned' }).expect(409)),
      ).toBe('INVALID_SIMULATION');
    });

    it('simulates returns, re-pricing, reroutes and exceptions', async () => {
      const returned = await create();
      expect(
        data<Shipment>(
          await simulate(returned.id, { to: 'returned' }).expect(200),
        ),
      ).toMatchObject({
        status: 'returned',
        return: { reason: 'not_collected' },
      });

      const repriced = await create();
      expect(
        code(await simulate(repriced.id, { to: 'fee_adjusted' }).expect(409)),
      ).toBe('INVALID_SIMULATION');
      await simulate(repriced.id, { to: 'received' }).expect(200);
      const adjusted = data<Shipment>(
        await simulate(repriced.id, { to: 'fee_adjusted' }).expect(200),
      );
      expect(adjusted.fee.chargedKobo).toBeGreaterThan(repriced.fee.quotedKobo);
      expect(adjusted.parcel.measured?.weightKg).toBeGreaterThan(0.4);

      const rerouted = data<Shipment>(
        await simulate(repriced.id, { to: 'destination_changed' }).expect(200),
      );
      expect(rerouted.destination.changed).toBe(true);
      expect(rerouted.destination.nodeId).not.toBe(node.home);

      const lost = data<Shipment>(
        await simulate(repriced.id, {
          to: 'exception',
          exceptionType: 'damaged',
        }).expect(200),
      );
      expect(lost).toMatchObject({
        status: 'exception',
        exception: { type: 'damaged' },
      });
    });
  });

  describe('modes and the test wallet', () => {
    it('lets the dashboard work in test mode and refuses live until approval', async () => {
      const viaDashboard = data<Shipment>(
        await http()
          .post('/api/v1/merchant/shipments')
          .set('Cookie', ownerCookies)
          .set('Locoomo-Mode', 'test')
          .send(shipmentBody())
          .expect(201),
      );
      expect(viaDashboard.mode).toBe('test');

      const live = await http()
        .post('/api/v1/merchant/shipments')
        .set('Cookie', ownerCookies)
        .set('Locoomo-Mode', 'live')
        .send(shipmentBody())
        .expect(403);
      expect(code(live)).toBe('MERCHANT_NOT_APPROVED');
      const liveList = data<Page>(
        await http()
          .get('/api/v1/merchant/shipments')
          .set('Cookie', ownerCookies)
          .set('Locoomo-Mode', 'live')
          .expect(200),
      );
      expect(liveList.items).toEqual([]);

      expect(
        code(
          await http()
            .get('/api/v1/merchant/shipments')
            .set('Cookie', ownerCookies)
            .set('Locoomo-Mode', 'production')
            .expect(400),
        ),
      ).toBe('INVALID_MODE');
    });

    it('refuses new holds beyond the ₦1,000,000 test wallet', async () => {
      const big = await create();
      await dataSource.query(
        `UPDATE merchant_shipments SET "quotedKobo" = 100000000 WHERE id = $1`,
        [big.id],
      );
      const refused = await api(key)
        .post('/shipments', shipmentBody())
        .expect(402);
      expect(code(refused)).toBe('INSUFFICIENT_WALLET_BALANCE');
      expect(
        details<{ requiredKobo: number; availableKobo: number }>(refused),
      ).toMatchObject({ availableKobo: expect.any(Number) as number });
      // Cancelling releases the hold.
      await api(key).post(`/shipments/${big.id}/cancel`).expect(200);
      await api(key).post('/shipments', shipmentBody()).expect(201);
    });
  });
});
