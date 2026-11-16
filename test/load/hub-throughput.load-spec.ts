// Hub throughput (plan §14, M5 exit criterion: 100k parcels/day through one
// hub). Not part of the e2e run: `npm run test:load` against the test DB.
//
// Seeds LOAD_PARCELS live merchant shipments from one hub to a handful of
// destinations, then checks them in with LOAD_SCANNERS staff scanning
// concurrently (each scanner is rate-limited to 600/min, as at a real hub).
// Every scan is the full production path: code resolution, drop-off,
// re-pricing, wallet charge, capacity, bagging (auto-seal at 50 and a
// courier booked per bag). Reports throughput and latency, and asserts an
// 8-hour shift clears 100,000 parcels.
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { LogisticsProviderRegistry } from '../../src/modules/logistics/application/logistics-provider.registry';
import { DeliveryLegStatus } from '../../src/modules/logistics/domain/delivery-leg';
import { ApiRateLimiter } from '../../src/modules/merchants/application/api-rate-limiter';
import { WalletService } from '../../src/modules/merchants/application/wallet.service';
import { WalletEntryType } from '../../src/modules/merchants/domain/wallet';
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';
import { BagService } from '../../src/modules/handoffs/application/bag.service';
import { ConfirmDropOffService } from '../../src/modules/handoffs/application/confirm-drop-off.service';
import { ReceiverNotificationService } from '../../src/modules/handoffs/application/receiver-notification.service';
import { RerouteService } from '../../src/modules/handoffs/application/reroute.service';
import { LiveShipmentSyncService } from '../../src/modules/merchants/application/live-shipment-sync.service';
import { ManifestService } from '../../src/modules/merchants/application/manifest.service';
import { MerchantShipmentService } from '../../src/modules/merchants/application/merchant-shipment.service';
import { WalletAlertsService } from '../../src/modules/merchants/application/wallet-alerts.service';
import { WebhookEmitterService } from '../../src/modules/merchants/application/webhook-emitter.service';
import { OrdersService } from '../../src/modules/orders/application/orders.service';
import { OutboxService } from '../../src/modules/notifications/application/outbox.service';
import { TrackingEmailService } from '../../src/modules/tracking/application/tracking-email.service';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'load.e2e.test';
const NODE_PREFIX = 'MLOAD-';
const CENTRE = { latitude: 6.6, longitude: 3.35 };
const PARCELS = Number(process.env.LOAD_PARCELS ?? 2_000);
const SCANNERS = Number(process.env.LOAD_SCANNERS ?? 4);
const PER_SCANNER = Number(process.env.LOAD_IN_FLIGHT ?? 2); // requests in flight per scanner
const DESTINATIONS = 5;
const COURIER = 'load_bags';
const TARGET_PER_DAY = 100_000;
const SHIFT_HOURS = 8;

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

const profile: Record<string, { calls: number; ms: number }> = {};

function percentile(sorted: number[], p: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

describe('Hub throughput (load)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<UserEntity>;
  let owner: string[];
  let merchantId: string;
  const scanners: string[][] = [];
  let hub = '';
  const destinations: string[] = [];

  const http = () => request(app.getHttpServer());
  const data = <T>(r: request.Response): T => (r.body as { data: T }).data;

  async function makeUser(
    name: string,
    overrides: Partial<UserEntity> = {},
  ): Promise<UserEntity> {
    return users.save(
      users.create({
        email: `${name}@${DOMAIN}`,
        passwordHash: await hashPassword(PASSWORD),
        firstName: name,
        lastName: 'Load',
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
    return data<{ id: string }>(
      await http()
        .post('/api/v1/nodes')
        .set('Cookie', admin)
        .send({
          name: `${NODE_PREFIX}${name}`,
          address: `${name} road`,
          city: 'Lagos',
          state: 'Lagos',
          latitude: CENTRE.latitude + offsetKm / 111,
          longitude: CENTRE.longitude,
          capacity: 100_000,
          ...NODE_CONTACT_FIELDS,
        })
        .expect(201),
    ).id;
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
            limit: 1_000_000,
            remaining: 999_999,
            resetSeconds: 1,
            retryAfterSeconds: 1,
          }),
        failedAttempt: () => Promise.resolve(false),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    const config = app.get(ConfigService);
    const get = config.get.bind(config) as (k: string, o?: unknown) => unknown;
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string, opts?: unknown) =>
        key === 'MERCHANT_LIVE_SHIPMENTS_ENABLED' ? true : get(key, opts),
      );
    dataSource = moduleFixture.get(DataSource);
    users = moduleFixture.get(getRepositoryToken(UserEntity));

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
    hub = await createNode(admin, 'Hub', 0);
    await http()
      .patch(`/api/v1/nodes/${hub}`)
      .set('Cookie', admin)
      .send({ isHub: true })
      .expect(200);
    for (let i = 0; i < DESTINATIONS; i++) {
      destinations.push(await createNode(admin, `Dest${i}`, 3 + i * 2));
    }
    const memberships = app.get<Repository<NodeMembershipEntity>>(
      getRepositoryToken(NodeMembershipEntity),
    );
    for (let i = 0; i < SCANNERS; i++) {
      const user = await makeUser(`scanner${i}`, {
        role: UserRole.NODE_OPERATOR,
      });
      await memberships.save(
        memberships.create({ userId: user.id, nodeId: hub }),
      );
      scanners.push(await signIn(user));
    }

    owner = await signIn(await makeUser('owner'));
    merchantId = data<{ merchant: { id: string } }>(
      await http()
        .post('/api/v1/merchant/account')
        .set('Cookie', owner)
        .send({ type: 'business', tradingName: 'Load Stores' })
        .expect(201),
    ).merchant.id;
    await dataSource.query(
      `UPDATE merchants SET status = 'approved', tier = 'enterprise', "hubNodeId" = $2,
              "contactEmail" = 'ops@${DOMAIN}' WHERE id = $1`,
      [merchantId, hub],
    );
    await dataSource.transaction((manager) =>
      app.get(WalletService).creditExternal(manager, {
        merchantId,
        mode: 'live',
        type: WalletEntryType.TOP_UP,
        amountKobo: 50_000_000_000,
        description: 'Load funding',
        externalRef: `load:${merchantId}`,
      }),
    );

    // Jest's module sandbox makes the QR PNG in the buyer's email ~1.3 s
    // (~35 ms in plain Node), which would swamp the measurement. Render it
    // once and reuse it; the real per-parcel cost is noted in the report.
    const tracking: TrackingEmailService = app.get(TrackingEmailService);
    type TrackingBlock = Awaited<
      ReturnType<TrackingEmailService['trackingBlock']>
    >;
    const realBlock = (code: string): Promise<TrackingBlock> =>
      TrackingEmailService.prototype.trackingBlock.call(
        tracking,
        code,
      ) as Promise<TrackingBlock>;
    let template: TrackingBlock | undefined;
    jest
      .spyOn(tracking, 'trackingBlock')
      .mockImplementation(async (code: string): Promise<TrackingBlock> => {
        template ??= await realBlock(code);
        return template;
      });

    // LOAD_PROFILE=1: time the steps of a scan (printed with the report).
    if (process.env.LOAD_PROFILE) {
      const targets: [object, string[]][] = [
        [ManifestService.prototype, ['scan']],
        [ConfirmDropOffService.prototype, ['confirm']],
        [OrdersService.prototype, ['markReceivedAtOrigin']],
        [LiveShipmentSyncService.prototype, ['onOrderStatusChanged']],
        [WalletService.prototype, ['captureHold', 'adjustShipmentCharge']],
        [ReceiverNotificationService.prototype, ['enqueueOnItsWay']],
        [BagService.prototype, ['sendOnward', 'onOrderStatusChanged']],
        [RerouteService.prototype, ['holdIfDestinationBlocked']],
        [MerchantShipmentService.prototype, ['price']],
        [WebhookEmitterService.prototype, ['emit']],
        [WalletAlertsService.prototype, ['check']],
        [TrackingEmailService.prototype, ['trackingBlock']],
        [OutboxService.prototype, ['enqueueEmail']],
      ];
      for (const [proto, methods] of targets) {
        for (const method of methods) {
          const original = (proto as Record<string, unknown>)[method] as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const label = `${proto.constructor.name}.${method}`;
          (proto as Record<string, unknown>)[method] = async function (
            this: unknown,
            ...args: unknown[]
          ) {
            const t = performance.now();
            try {
              return (await original.apply(this, args)) as unknown;
            } finally {
              const row = (profile[label] ??= { calls: 0, ms: 0 });
              row.calls += 1;
              row.ms += performance.now() - t;
            }
          };
        }
      }
    }

    // A bag courier, so every auto-sealed bag books a leg as in production.
    app.get(LogisticsProviderRegistry).register({
      key: COURIER,
      capabilities: {
        vehicleClasses: ['motorbike', 'car', 'van'] as never,
        handover: 'provider_code',
        updates: 'webhook',
        remoteSubmission: false,
        cancellableUntil: 'requested' as never,
        prepaidWallet: false,
        carriesBags: true,
      },
      createDelivery: (req) =>
        Promise.resolve({
          externalId: `ext-${req.legId}`,
          status: 'requested' as DeliveryLegStatus,
          providerStatus: 'pending',
          quotedKobo: 300_000,
          trackingUrl: null,
          etaMinutes: 60,
          distanceMeters: null,
        }),
      cancel: () => Promise.resolve(),
    });
    await dataSource.query(
      `INSERT INTO logistics_providers (key, label, enabled, priority, "maxAttempts")
       VALUES ($1, 'Load bag courier', true, 2000, 3) ON CONFLICT (key) DO NOTHING`,
      [COURIER],
    );
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      const pattern = `%@${DOMAIN}`;
      // Setup may have stopped part-way: ids that were never set match nothing.
      hub ||= '00000000-0000-0000-0000-000000000000';
      merchantId ||= '00000000-0000-0000-0000-000000000000';
      const ours = `SELECT id FROM orders WHERE "merchantId" = $1`;
      const ourBags = `SELECT id FROM bags WHERE "originNodeId" = $1`;
      await dataSource.query(
        `DELETE FROM delivery_legs WHERE "bagId" IN (${ourBags})`,
        [hub],
      );
      await dataSource.query(
        `DELETE FROM delivery_legs WHERE "orderId" IN (${ours})`,
        [merchantId],
      );
      await dataSource.query(`DELETE FROM logistics_providers WHERE key = $1`, [
        COURIER,
      ]);
      await dataSource.query(
        `DELETE FROM order_events WHERE "orderId" IN (${ours})`,
        [merchantId],
      );
      await dataSource.query(
        `DELETE FROM handoff_codes WHERE "orderId" IN (${ours})`,
        [merchantId],
      );
      await dataSource.query(
        `DELETE FROM audit_events WHERE "merchantId" = $1 OR "actorId" IN (SELECT id FROM users WHERE email LIKE $2)`,
        [merchantId, pattern],
      );
      await dataSource.query(`DELETE FROM merchants WHERE id = $1`, [
        merchantId,
      ]);
      await dataSource.query(`DELETE FROM orders WHERE "merchantId" = $1`, [
        merchantId,
      ]);
      await dataSource.query(`DELETE FROM bags WHERE id IN (${ourBags})`, [
        hub,
      ]);
      await dataSource.query(
        `DELETE FROM pricing_rules WHERE "createdByAdminId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM node_memberships WHERE "nodeId" IN (SELECT id FROM nodes WHERE name LIKE $1)`,
        [`${NODE_PREFIX}%`],
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
  }, 300_000);

  it(`checks ${PARCELS} parcels in at one hub fast enough for ${TARGET_PER_DAY.toLocaleString('en')} a day`, async () => {
    // Seed, 100 per bulk call.
    const codes: string[] = [];
    const seedStart = Date.now();
    for (let batch = 0; batch * 100 < PARCELS; batch++) {
      const items = Array.from(
        { length: Math.min(100, PARCELS - batch * 100) },
        (_, i) => ({
          reference: `LOAD-${batch}-${i}-${randomUUID().slice(0, 6)}`,
          destinationNodeId: destinations[(batch * 100 + i) % DESTINATIONS],
          origin: { type: 'hub' },
          receiver: {
            name: 'Load Buyer',
            phone: '08031234567',
            email: `buyer@${DOMAIN}`,
          },
          parcel: { description: 'Parcel', size: 'small', weightKg: 0.5 },
        }),
      );
      const results = data<{
        results: { shipment?: { trackingCode: string } }[];
      }>(
        await http()
          .post('/api/v1/merchant/shipments/bulk')
          .set('Cookie', owner)
          .set('X-Locoomo-Client', 'web')
          .set('Locoomo-Mode', 'live')
          .send({ items })
          .expect(200),
      ).results;
      for (const r of results) {
        if (r.shipment) {
          codes.push(r.shipment.trackingCode);
        }
      }
    }
    const seedSeconds = (Date.now() - seedStart) / 1000;
    expect(codes.length).toBe(PARCELS);

    // Check in: SCANNERS staff, PER_SCANNER requests each in flight.
    const latencies: number[] = [];
    let next = 0;
    let failures = 0;
    const lane = async (cookie: string[]) => {
      while (next < codes.length) {
        const code = codes[next++];
        const t = Date.now();
        const r = await http()
          .post('/api/v1/handoffs/hub-intake')
          .set('Cookie', cookie)
          .set('X-Locoomo-Client', 'web')
          .send({ code });
        latencies.push(Date.now() - t);
        if (r.status !== 200) {
          failures++;
        }
      }
    };
    const start = Date.now();
    await Promise.all(
      scanners.flatMap((cookie) =>
        Array.from({ length: PER_SCANNER }, () => lane(cookie)),
      ),
    );
    const seconds = (Date.now() - start) / 1000;
    latencies.sort((a, b) => a - b);
    const perSecond = codes.length / seconds;
    const [bags] = await dataSource.query<
      { bags: number; sealed: number; legs: number }[]
    >(
      `SELECT count(*)::int AS bags,
                count(*) FILTER (WHERE status = 'sealed')::int AS sealed,
                (SELECT count(*)::int FROM delivery_legs l
                   JOIN bags x ON x.id = l."bagId" WHERE x."originNodeId" = $1) AS legs
           FROM bags WHERE "originNodeId" = $1`,
      [hub],
    );

    const report = {
      parcels: codes.length,
      scanners: SCANNERS,
      inFlight: SCANNERS * PER_SCANNER,
      seedSeconds: Math.round(seedSeconds * 10) / 10,
      scanSeconds: Math.round(seconds * 10) / 10,
      scansPerSecond: Math.round(perSecond * 10) / 10,
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies[latencies.length - 1],
      },
      failures,
      bags,
      perEightHourShift: Math.round(perSecond * SHIFT_HOURS * 3600),
      per24h: Math.round(perSecond * 86_400),
      note: 'buyer-email QR rendered once (Jest sandbox artefact); ~35 ms/parcel in production',
    };
    console.log(`HUB LOAD REPORT ${JSON.stringify(report)}`);
    if (process.env.LOAD_PROFILE) {
      const steps = Object.fromEntries(
        Object.entries(profile).map(([k, v]) => [
          k,
          { calls: v.calls, avgMs: Math.round(v.ms / v.calls) },
        ]),
      );
      console.log(`HUB LOAD PROFILE ${JSON.stringify(steps)}`);
    }

    expect(failures).toBe(0);
    expect(report.perEightHourShift).toBeGreaterThanOrEqual(TARGET_PER_DAY);
  }, 1_800_000);
});
