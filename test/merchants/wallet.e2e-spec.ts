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
import { WalletReconciliationService } from '../../src/modules/merchants/application/wallet-reconciliation.service';
import { WalletService } from '../../src/modules/merchants/application/wallet.service';
import { lagosMonth } from '../../src/modules/merchants/domain/statement';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'wallet.e2e.test';
const NODE_PREFIX = 'MWAL-';
const CENTRE = { latitude: 7.42, longitude: 3.95 };
const FUNDING = 100_000_000;

interface ErrorBody {
  error: { code: string; details?: unknown };
}
interface Wallet {
  mode: string;
  currency: string;
  balanceKobo: number;
  heldKobo: number;
  availableKobo: number;
}
interface Entry {
  id: string;
  type: string;
  amountKobo: number;
  balanceAfterKobo: number;
  description: string;
  shipmentId: string | null;
}
interface Hold {
  shipmentId: string;
  status: string;
  amountKobo: number;
  capturedKobo: number | null;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
interface Shipment {
  id: string;
  trackingCode: string;
  fee: { quotedKobo: number; chargedKobo: number | null; state: string };
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant wallet (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let ownerCookies: string[];
  let merchantId: string;
  let key: string;
  let shipmentsOnlyKey: string;
  let finance: string[];
  let financeChecker: string[];
  let financeUserId: string;
  let ops: string[];
  const node = { origin: '', home: '', far: '' };

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const code = (response: request.Response): string =>
    (response.body as ErrorBody).error.code;
  const data = <T>(response: request.Response): T =>
    (response.body as { data: T }).data;

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

  const wallet = async (): Promise<Wallet> =>
    data<Wallet>(await api(key).get('/wallet').expect(200));
  const entries = async (query = ''): Promise<Page<Entry>> =>
    data<Page<Entry>>(
      await api(key).get(`/wallet/entries${query}`).expect(200),
    );

  const shipmentBody = (overrides: Record<string, unknown> = {}) => ({
    reference: `W-${randomUUID().slice(0, 8)}`,
    destinationNodeId: node.home,
    origin: { type: 'node', nodeId: node.origin },
    receiver: {
      name: 'Chioma Okafor',
      phone: '08031234567',
      email: 'c@example.com',
    },
    parcel: { description: 'Earbuds', size: 'small', weightKg: 0.4 },
    ...overrides,
  });
  const create = async (): Promise<Shipment> =>
    data<Shipment>(
      await api(key).post('/shipments', shipmentBody()).expect(201),
    );
  const simulate = (id: string, to: string) =>
    api(key).post(`/test/shipments/${id}/simulate`, { to }).expect(200);

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

  const makeAdmin = (name: string, permissions: AdminPermission[]) =>
    makeUser(name, { role: UserRole.ADMIN, adminPermissions: permissions });

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

  async function newKey(body: object): Promise<string> {
    return data<{ secret: string }>(
      await http()
        .post('/api/v1/merchant/api-keys')
        .set('Cookie', ownerCookies)
        .send({ mode: 'test', name: 'k', kind: 'secret', ...body })
        .expect(201),
    ).secret;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
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

    const superAdmin = await signIn(
      await makeAdmin('super', [AdminPermission.SUPER]),
    );
    await http()
      .post('/api/v1/admin/pricing')
      .set('Cookie', superAdmin)
      .send({ baseFeeNaira: 500, perKmRateNaira: 100, destinationFeeNaira: 50 })
      .expect(201);
    node.origin = await createNode(superAdmin, 'Origin', 0);
    node.home = await createNode(superAdmin, 'Home', 2);
    node.far = await createNode(superAdmin, 'Far', 9);

    const financeUser = await makeAdmin('finance', [AdminPermission.FINANCE]);
    financeUserId = financeUser.id;
    finance = await signIn(financeUser);
    financeChecker = await signIn(
      await makeAdmin('checker', [AdminPermission.FINANCE]),
    );
    ops = await signIn(await makeAdmin('ops', [AdminPermission.OPS]));

    ownerCookies = await signIn(await makeUser('owner'));
    merchantId = data<{ merchant: { id: string } }>(
      await http()
        .post('/api/v1/merchant/account')
        .set('Cookie', ownerCookies)
        .send({ type: 'business', tradingName: 'Wallet Stores' })
        .expect(201),
    ).merchant.id;
    key = await newKey({});
    shipmentsOnlyKey = await newKey({ scopes: ['shipments:read'] });
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
        `DELETE FROM approval_requests WHERE "requestedByUserId" IN (SELECT id FROM users WHERE email LIKE $1)`,
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

  describe('test wallet', () => {
    it('starts funded with ₦1,000,000 and shows the funding entry', async () => {
      expect(await wallet()).toMatchObject({
        mode: 'test',
        currency: 'NGN',
        balanceKobo: FUNDING,
        heldKobo: 0,
        availableKobo: FUNDING,
      });
      const page = await entries();
      expect(page.items).toEqual([
        expect.objectContaining({
          type: 'test_funding',
          amountKobo: FUNDING,
          balanceAfterKobo: FUNDING,
        }),
      ]);
    });

    it('holds the quoted fee at creation and releases it on cancel', async () => {
      const shipment = await create();
      const quoted = shipment.fee.quotedKobo;
      expect(await wallet()).toMatchObject({
        balanceKobo: FUNDING,
        heldKobo: quoted,
        availableKobo: FUNDING - quoted,
      });
      const holds = data<Page<Hold>>(
        await api(key).get('/wallet/holds?status=active').expect(200),
      );
      expect(holds.items).toEqual([
        expect.objectContaining({
          shipmentId: shipment.id,
          status: 'active',
          amountKobo: quoted,
        }),
      ]);

      await api(key).post(`/shipments/${shipment.id}/cancel`).expect(200);
      expect(await wallet()).toMatchObject({
        balanceKobo: FUNDING,
        heldKobo: 0,
      });
      const released = data<Page<Hold>>(
        await api(key).get('/wallet/holds?status=released').expect(200),
      );
      expect(released.items[0]).toMatchObject({
        shipmentId: shipment.id,
        status: 'released',
      });
    });

    it('re-sizes the hold when a re-route changes the price', async () => {
      const shipment = await create();
      const moved = data<Shipment>(
        await api(key)
          .patch(`/shipments/${shipment.id}`, { destinationNodeId: node.far })
          .expect(200),
      );
      expect(moved.fee.quotedKobo).toBeGreaterThan(shipment.fee.quotedKobo);
      expect((await wallet()).heldKobo).toBe(moved.fee.quotedKobo);
      await api(key).post(`/shipments/${shipment.id}/cancel`).expect(200);
    });

    it('captures at drop-off and charges the difference after re-measuring', async () => {
      const shipment = await create();
      const quoted = shipment.fee.quotedKobo;
      await simulate(shipment.id, 'received');
      expect(await wallet()).toMatchObject({
        balanceKobo: FUNDING - quoted,
        heldKobo: 0,
      });

      const adjusted = data<Shipment>(
        await simulate(shipment.id, 'fee_adjusted'),
      );
      const extra = adjusted.fee.chargedKobo! - quoted;
      expect(extra).toBeGreaterThan(0);
      expect((await wallet()).balanceKobo).toBe(FUNDING - quoted - extra);

      const lines = (await entries()).items;
      expect(lines.slice(0, 2)).toEqual([
        expect.objectContaining({
          type: 'shipment_adjustment',
          amountKobo: -extra,
          shipmentId: shipment.id,
        }),
        expect.objectContaining({
          type: 'shipment_charge',
          amountKobo: -quoted,
          shipmentId: shipment.id,
          description: `Shipment ${shipment.trackingCode}`,
        }),
      ]);
      const filtered = await entries('?type=shipment_charge');
      expect(filtered.items.every((e) => e.type === 'shipment_charge')).toBe(
        true,
      );
    });

    it('releases the hold when a parcel is refused or expires', async () => {
      const refused = await create();
      await simulate(refused.id, 'refused');
      const expired = await create();
      await simulate(expired.id, 'expired');
      expect((await wallet()).heldKobo).toBe(0);
    });

    it('resets the balance to ₦1,000,000 and keeps open holds', async () => {
      const open = await create();
      const reset = data<Wallet>(
        await api(key).post('/test/wallet/reset').expect(200),
      );
      expect(reset).toMatchObject({
        balanceKobo: FUNDING,
        heldKobo: open.fee.quotedKobo,
      });
      expect((await entries()).items[0]).toMatchObject({
        type: 'test_funding',
        description: 'Test wallet reset',
        balanceAfterKobo: FUNDING,
      });
      await api(key).post(`/shipments/${open.id}/cancel`).expect(200);
    });

    it('pages through entries without skipping rows written together', async () => {
      const all: Entry[] = [];
      let cursor: string | null = null;
      do {
        const page = await entries(
          `?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const everything = (await entries('?limit=200')).items;
      expect(all.map((e) => e.id)).toEqual(everything.map((e) => e.id));
    });
  });

  describe('access', () => {
    it('needs the wallet:read scope for keys', async () => {
      expect(code(await api(shipmentsOnlyKey).get('/wallet').expect(403))).toBe(
        'INSUFFICIENT_SCOPE',
      );
    });

    it('works from the dashboard per mode, and reset is test-only', async () => {
      const live = data<Wallet>(
        await http()
          .get('/api/v1/merchant/wallet')
          .set('Cookie', ownerCookies)
          .set('Locoomo-Mode', 'live')
          .expect(200),
      );
      expect(live).toMatchObject({ mode: 'live', balanceKobo: 0, heldKobo: 0 });
      const liveReset = await http()
        .post('/api/v1/merchant/test/wallet/reset')
        .set('Cookie', ownerCookies)
        .set('X-Locoomo-Client', 'web')
        .set('Locoomo-Mode', 'live')
        .expect(403);
      expect(code(liveReset)).toBe('TEST_MODE_ONLY');
    });
  });

  describe('admin adjustments (two-admin rule)', () => {
    it('credits the wallet only after a second finance admin approves', async () => {
      const requested = data<{
        approvalId: string;
        status: string;
        summary: string;
      }>(
        await http()
          .post(`/api/v1/admin/merchants/${merchantId}/wallet/adjustments`)
          .set('Cookie', finance)
          .send({
            mode: 'live',
            amountKobo: 2_500_000,
            reason: 'Goodwill credit for a delayed parcel',
            merchantNote: 'Goodwill credit',
          })
          .expect(201),
      );
      expect(requested).toMatchObject({
        status: 'pending',
        summary: 'Credit ₦25,000.00 to Wallet Stores (live wallet)',
      });

      const liveWallet = () =>
        http()
          .get(`/api/v1/admin/merchants/${merchantId}/wallet?mode=live`)
          .set('Cookie', ops)
          .expect(200);
      expect(data<Wallet>(await liveWallet()).balanceKobo).toBe(0);

      expect(
        code(
          await http()
            .post(`/api/v1/admin/approvals/${requested.approvalId}/approve`)
            .set('Cookie', finance)
            .send({})
            .expect(403),
        ),
      ).toBe('SELF_APPROVAL_NOT_ALLOWED');
      expect(
        code(
          await http()
            .post(`/api/v1/admin/approvals/${requested.approvalId}/approve`)
            .set('Cookie', ops)
            .send({})
            .expect(403),
        ),
      ).toBe('FORBIDDEN');

      const approved = data<{
        status: string;
        result: { balanceAfterKobo: number };
      }>(
        await http()
          .post(`/api/v1/admin/approvals/${requested.approvalId}/approve`)
          .set('Cookie', financeChecker)
          .send({})
          .expect(200),
      );
      expect(approved).toMatchObject({
        status: 'executed',
        result: { balanceAfterKobo: 2_500_000 },
      });
      expect(data<Wallet>(await liveWallet()).balanceKobo).toBe(2_500_000);

      const liveEntries = data<Page<Entry>>(
        await http()
          .get('/api/v1/merchant/wallet/entries')
          .set('Cookie', ownerCookies)
          .set('Locoomo-Mode', 'live')
          .expect(200),
      );
      expect(liveEntries.items).toEqual([
        expect.objectContaining({
          type: 'adjustment',
          amountKobo: 2_500_000,
          description: 'Goodwill credit',
        }),
      ]);
      const [audit] = await dataSource.query<{ actorId: string }[]>(
        `SELECT "actorId" FROM audit_events WHERE action = 'wallet.adjusted' AND "merchantId" = $1`,
        [merchantId],
      );
      expect(audit).toBeDefined();
      expect(audit.actorId).not.toBe(financeUserId);
    });

    it('only finance admins can raise one, and the amount must be sane', async () => {
      await http()
        .post(`/api/v1/admin/merchants/${merchantId}/wallet/adjustments`)
        .set('Cookie', ops)
        .send({ mode: 'live', amountKobo: 100, reason: 'Not allowed' })
        .expect(403);
      const zero = await http()
        .post(`/api/v1/admin/merchants/${merchantId}/wallet/adjustments`)
        .set('Cookie', finance)
        .send({ mode: 'live', amountKobo: 0, reason: 'Nothing' })
        .expect(400);
      expect(code(zero)).toBe('VALIDATION_FAILED');
      await http()
        .post(`/api/v1/admin/merchants/${randomUUID()}/wallet/adjustments`)
        .set('Cookie', finance)
        .send({ mode: 'live', amountKobo: 100, reason: 'Unknown merchant' })
        .expect(404);
    });
  });

  describe('alerts and pricing (M4e)', () => {
    const lowBalanceEvents = async (): Promise<number> => {
      const [{ count }] = await dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM webhook_events
          WHERE "merchantId" = $1 AND type = 'wallet.low_balance' AND mode = 'test'`,
        [merchantId],
      );
      return count;
    };
    const setThreshold = (value: number | null) =>
      http()
        .patch('/api/v1/merchant/wallet/settings')
        .set('Cookie', ownerCookies)
        .set('X-Locoomo-Client', 'web')
        .set('Locoomo-Mode', 'test')
        .send({ lowBalanceThresholdKobo: value });

    it('alerts once when available drops below the merchant’s line, and re-arms', async () => {
      await api(key).post('/test/wallet/reset').expect(200);
      const { availableKobo } = await wallet();
      const before = await lowBalanceEvents();

      // Just under what's available: the next shipment crosses it.
      const set = data<{ lowBalanceThresholdKobo: number }>(
        await setThreshold(availableKobo - 1).expect(200),
      );
      expect(set.lowBalanceThresholdKobo).toBe(availableKobo - 1);
      expect(await lowBalanceEvents()).toBe(before);

      const first = await create();
      expect(await lowBalanceEvents()).toBe(before + 1);
      const second = await create();
      expect(await lowBalanceEvents()).toBe(before + 1);

      const [event] = await dataSource.query<{ body: string }[]>(
        `SELECT body FROM webhook_events WHERE "merchantId" = $1 AND type = 'wallet.low_balance'
          ORDER BY "createdAt" DESC LIMIT 1`,
        [merchantId],
      );
      expect(JSON.parse(event.body)).toMatchObject({
        data: { thresholdKobo: availableKobo - 1 },
      });

      // Back above the line (cancelled holds), then below again: alerts again.
      await api(key).post(`/shipments/${first.id}/cancel`).expect(200);
      await api(key).post(`/shipments/${second.id}/cancel`).expect(200);
      const third = await create();
      expect(await lowBalanceEvents()).toBe(before + 2);
      await api(key).post(`/shipments/${third.id}/cancel`).expect(200);

      await setThreshold(null).expect(200);
      expect((await wallet()) as unknown).toMatchObject({
        lowBalanceThresholdKobo: null,
      });
    });

    it('tells finance when a live wallet goes below its floor', async () => {
      await dataSource.query(
        `UPDATE merchants SET tier = 'business', "limitOverrides" = '{"negativeBalanceFloorKobo": -100}'::jsonb WHERE id = $1`,
        [merchantId],
      );
      const requested = data<{ approvalId: string }>(
        await http()
          .post(`/api/v1/admin/merchants/${merchantId}/wallet/adjustments`)
          .set('Cookie', finance)
          .send({
            mode: 'live',
            amountKobo: -100_000_000,
            reason: 'Floor test',
          })
          .expect(201),
      );
      await http()
        .post(`/api/v1/admin/approvals/${requested.approvalId}/approve`)
        .set('Cookie', financeChecker)
        .send({})
        .expect(200);
      const alerts = async (): Promise<number> => {
        const [{ count }] = await dataSource.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM outbox_events
            WHERE "eventType" = 'email' AND payload ->> 'subject' = $1`,
          ['Wallet below floor: Wallet Stores'],
        );
        return count;
      };
      const sent = await alerts();
      expect(sent).toBeGreaterThan(0);
      // Still below: no second round of emails.
      const again = data<{ approvalId: string }>(
        await http()
          .post(`/api/v1/admin/merchants/${merchantId}/wallet/adjustments`)
          .set('Cookie', finance)
          .send({ mode: 'live', amountKobo: -100, reason: 'Floor test again' })
          .expect(201),
      );
      await http()
        .post(`/api/v1/admin/approvals/${again.approvalId}/approve`)
        .set('Cookie', financeChecker)
        .send({})
        .expect(200);
      expect(await alerts()).toBe(sent);
      await dataSource.query(
        `UPDATE merchants SET "limitOverrides" = NULL WHERE id = $1`,
        [merchantId],
      );
    });

    it('lets finance set tiers and a negotiated discount', async () => {
      const initial = data<{
        tiers: { minShipments: number; percent: number }[];
      }>(
        await http()
          .get('/api/v1/admin/pricing/volume-tiers')
          .set('Cookie', ops)
          .expect(200),
      );
      expect(initial.tiers[0]).toEqual({ minShipments: 0, percent: 0 });
      expect(
        code(
          await http()
            .put('/api/v1/admin/pricing/volume-tiers')
            .set('Cookie', finance)
            .send({ tiers: [{ minShipments: 10, percent: 5 }] })
            .expect(422),
        ),
      ).toBe('INVALID_DISCOUNT_TIERS');
      await http()
        .put('/api/v1/admin/pricing/volume-tiers')
        .set('Cookie', ops)
        .send({ tiers: initial.tiers })
        .expect(403);

      expect(
        data<{ percent: number; source: string }>(
          await api(key).get('/pricing').expect(200),
        ),
      ).toMatchObject({ percent: 0, source: 'tier' });
      const set = data<{ percent: number; source: string }>(
        await http()
          .put(`/api/v1/admin/merchants/${merchantId}/pricing`)
          .set('Cookie', finance)
          .send({ discountPercent: 7.5 })
          .expect(200),
      );
      expect(set).toMatchObject({ percent: 7.5, source: 'negotiated' });
      expect(
        data<{ percent: number }>(await api(key).get('/pricing').expect(200))
          .percent,
      ).toBe(7.5);
      await http()
        .put(`/api/v1/admin/merchants/${merchantId}/pricing`)
        .set('Cookie', finance)
        .send({ discountPercent: null })
        .expect(200);
    });
  });

  describe('reconciliation', () => {
    it('finds no drift after real activity, and reports a tampered wallet', async () => {
      const reconciliation = app.get(WalletReconciliationService);
      const ours = (drifts: { merchantId: string }[]) =>
        drifts.filter((d) => d.merchantId === merchantId);
      expect(ours(await reconciliation.run())).toEqual([]);

      await dataSource.query(
        `UPDATE merchant_wallets SET "balanceKobo" = "balanceKobo" + 1 WHERE "merchantId" = $1 AND mode = 'test'`,
        [merchantId],
      );
      try {
        expect(ours(await reconciliation.run())).toEqual([
          expect.objectContaining({ mode: 'test' }),
        ]);
      } finally {
        await dataSource.query(
          `UPDATE merchant_wallets SET "balanceKobo" = "balanceKobo" - 1 WHERE "merchantId" = $1 AND mode = 'test'`,
          [merchantId],
        );
      }
    });
  });

  // After reconciliation: the seeded live lines net to zero, so the ledger
  // still sums to the balance either way.
  describe('statements and tax invoices (M4e2)', () => {
    const binary = (req: request.Test) =>
      req.buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    const now = new Date();
    const thisMonth = lagosMonth(now);
    const [year, month] = thisMonth.split('-').map(Number);
    const lastMonth =
      month === 1
        ? `${year - 1}-12`
        : `${year}-${String(month - 1).padStart(2, '0')}`;
    const session = (url: string, mode: 'test' | 'live') =>
      http()
        .get(`/api/v1/merchant${url}`)
        .set('Cookie', ownerCookies)
        .set('Locoomo-Mode', mode);

    beforeAll(async () => {
      const liveWallet = await dataSource.transaction((manager) =>
        app.get(WalletService).walletFor(manager, merchantId, 'live', true),
      );
      const at = new Date(`${lastMonth}-10T12:00:00+01:00`);
      const lines: [string, number, string][] = [
        ['top_up', 105_000, 'Card top-up'],
        ['shipment_charge', -107_500, 'Shipment LCM-TEST'],
        ['shipment_adjustment', 2_500, 'Re-priced after measuring'],
      ];
      let balance = 0;
      for (const [index, [type, amount, description]] of lines.entries()) {
        balance += amount;
        await dataSource.query(
          `INSERT INTO wallet_entries ("walletId", "merchantId", mode, type, "amountKobo", "balanceAfterKobo", description, "createdAt")
           VALUES ($1, $2, 'live', $3, $4, $5, $6, $7)`,
          [
            liveWallet.id,
            merchantId,
            type,
            amount,
            balance,
            description,
            new Date(at.getTime() + index * 60_000),
          ],
        );
      }
    });

    it('gives a test-mode statement as CSV, closing on the balance', async () => {
      const response = await api(key)
        .get(`/statements/${thisMonth}?format=csv`)
        .expect(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="locoomo-statement-${thisMonth}-test.csv"`,
      );
      const rows = response.text.trim().split('\r\n');
      expect(rows[0]).toBe(
        'date,type,description,reference,tracking_code,amount_ngn,balance_after_ngn',
      );
      expect(rows[1]).toMatch(/^,opening_balance,Opening balance,,,,/);
      const { balanceKobo } = await wallet();
      const naira = `${Math.floor(balanceKobo / 100)}.${String(balanceKobo % 100).padStart(2, '0')}`;
      expect(rows[rows.length - 1]).toBe(
        `,closing_balance,Closing balance,,,,${naira}`,
      );
      expect(rows.length).toBeGreaterThan(3);
    });

    it('gives the statement as a PDF', async () => {
      const response = await binary(
        api(key).get(`/statements/${thisMonth}`),
      ).expect(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('refuses bad and future months, and keys without wallet:read', async () => {
      expect(code(await api(key).get('/statements/2026-13').expect(422))).toBe(
        'INVALID_STATEMENT_MONTH',
      );
      expect(
        code(
          await api(key)
            .get(`/statements/${year + 1}-01`)
            .expect(422),
        ),
      ).toBe('INVALID_STATEMENT_MONTH');
      expect(
        code(
          await api(shipmentsOnlyKey)
            .get(`/statements/${thisMonth}`)
            .expect(403),
        ),
      ).toBe('INSUFFICIENT_SCOPE');
    });

    it('issues invoices for finished live months only', async () => {
      expect(
        code(await api(key).get(`/invoices/${lastMonth}`).expect(409)),
      ).toBe('INVOICE_NOT_AVAILABLE');
      expect(
        code(await session(`/invoices/${thisMonth}`, 'live').expect(409)),
      ).toBe('INVOICE_NOT_AVAILABLE');

      const csv = await session(
        `/invoices/${lastMonth}?format=csv`,
        'live',
      ).expect(200);
      const number = `LCM-INV-${lastMonth.replace('-', '')}-${merchantId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      expect(csv.text.trim().split('\r\n')).toEqual([
        'invoice_number,period,description,quantity,amount_ngn',
        `${number},${lastMonth},Parcel delivery to Locoomo Nodes,1,1075.00`,
        `${number},${lastMonth},Re-pricing after measuring at drop-off,1,-25.00`,
        `${number},${lastMonth},Total,,1050.00`,
      ]);

      const pdf = await binary(
        session(`/invoices/${lastMonth}`, 'live'),
      ).expect(200);
      expect(pdf.headers['content-disposition']).toBe(
        `attachment; filename="${number}.pdf"`,
      );
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('lists the live month with its opening and closing balance', async () => {
      const csv = await session(
        `/statements/${lastMonth}?format=csv`,
        'live',
      ).expect(200);
      const rows = csv.text.trim().split('\r\n');
      expect(rows).toHaveLength(6);
      expect(rows[2]).toMatch(/,top_up,Card top-up,,,1050\.00,1050\.00$/);
      expect(rows[5]).toBe(',closing_balance,Closing balance,,,,0.00');
    });

    it('lets finance, ops and support download them for any merchant', async () => {
      const admin = `/api/v1/admin/merchants/${merchantId}`;
      const statement = await http()
        .get(`${admin}/statements/${lastMonth}?mode=live&format=csv`)
        .set('Cookie', ops)
        .expect(200);
      expect(statement.text).toContain('closing_balance');
      const invoice = await binary(
        http().get(`${admin}/invoices/${lastMonth}`).set('Cookie', finance),
      ).expect(200);
      expect((invoice.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });
  });
});
