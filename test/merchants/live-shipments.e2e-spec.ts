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
import { ShipmentExpiryService } from '../../src/modules/merchants/application/shipment-expiry.service';
import { WalletReconciliationService } from '../../src/modules/merchants/application/wallet-reconciliation.service';
import { WalletService } from '../../src/modules/merchants/application/wallet.service';
import { WalletEntryType } from '../../src/modules/merchants/domain/wallet';
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
import { MerchantPricingService } from '../../src/modules/merchants/application/merchant-pricing.service';
import { OrdersService } from '../../src/modules/orders/application/orders.service';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';
import { BagService } from '../../src/modules/handoffs/application/bag.service';
import { DeliveryEventsService } from '../../src/modules/logistics/application/delivery-events.service';
import { LogisticsProviderRegistry } from '../../src/modules/logistics/application/logistics-provider.registry';
import { DeliveryLegStatus } from '../../src/modules/logistics/domain/delivery-leg';
import { RerouteService } from '../../src/modules/handoffs/application/reroute.service';
import { ReturnStorageService } from '../../src/modules/merchants/application/return-storage.service';
import { PlatformHealthService } from '../../src/modules/admin/application/platform-health.service';
import { PrivacyService } from '../../src/modules/admin/application/privacy.service';
import { CloudinaryService } from '../../src/common/cloudinary/cloudinary.service';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'live.e2e.test';
const NODE_PREFIX = 'MLIV-';
const FUNDS = 50_000_000;

interface ErrorBody {
  error: { code: string; details?: unknown };
}
interface Shipment {
  id: string;
  mode: string;
  reference: string;
  externalBarcode: string | null;
  origin: { type: string; nodeId: string | null };
  trackingCode: string;
  trackingUrl: string | null;
  status: string;
  sequence: number;
  fee: { quotedKobo: number; chargedKobo: number | null; state: string };
  collection: {
    deadline: string | null;
    collectedAt: string | null;
    method: string | null;
  };
  return: { reason: string; readyForCollectionAt: string | null } | null;
  exception: { type: string; claimId: string | null } | null;
}
interface Order {
  id: string;
  status: string;
  source: string;
  merchantId: string | null;
  consumerId: string | null;
  amountKobo: number;
  originNodeId: string;
  returnRequestedAt: Date | null;
  returnReason: string | null;
}
interface Wallet {
  balanceKobo: number;
  heldKobo: number;
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Live merchant shipments (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let orders: OrdersService;
  let owner: string[];
  let originOperator: string[];
  let destinationOperator: string[];
  let elsewhereOperator: string[];
  let multiNodeOperator: string[];
  let merchantId: string;
  const node = {
    origin: '',
    destination: '',
    elsewhere: '',
    northA: '',
    northB: '',
  };

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const code = (response: request.Response): string =>
    (response.body as ErrorBody).error.code;
  const data = <T>(response: request.Response): T =>
    (response.body as { data: T }).data;

  const live = {
    get: (url: string) =>
      http()
        .get(`/api/v1/merchant${url}`)
        .set('Cookie', owner)
        .set('Locoomo-Mode', 'live'),
    post: (url: string, body: object = {}) =>
      http()
        .post(`/api/v1/merchant${url}`)
        .set('Cookie', owner)
        .set('X-Locoomo-Client', 'web')
        .set('Locoomo-Mode', 'live')
        .send(body),
    patch: (url: string, body: object) =>
      http()
        .patch(`/api/v1/merchant${url}`)
        .set('Cookie', owner)
        .set('X-Locoomo-Client', 'web')
        .set('Locoomo-Mode', 'live')
        .send(body),
  };
  const handoff = (
    cookie: string[],
    orderId: string,
    step: string,
    body = {},
  ) =>
    http()
      .post(`/api/v1/handoffs/orders/${orderId}/${step}`)
      .set('Cookie', cookie)
      .set('X-Locoomo-Client', 'web')
      .send(body);

  const wallet = async (): Promise<Wallet> =>
    data<Wallet>(await live.get('/wallet').expect(200));
  const shipment = async (id: string): Promise<Shipment> =>
    data<Shipment>(await live.get(`/shipments/${id}`).expect(200));
  const orderOf = async (trackingCode: string): Promise<Order> => {
    const [row] = await dataSource.query<Order[]>(
      `SELECT * FROM orders WHERE "trackingCode" = $1`,
      [trackingCode],
    );
    return row;
  };
  const originCount = async (): Promise<number> => {
    const [row] = await dataSource.query<{ currentCount: number }[]>(
      `SELECT "currentCount" FROM nodes WHERE id = $1`,
      [node.origin],
    );
    return row.currentCount;
  };

  const create = async (overrides: Record<string, unknown> = {}) =>
    data<Shipment>(
      await live
        .post('/shipments', {
          reference: `L-${randomUUID().slice(0, 8)}`,
          destinationNodeId: node.destination,
          origin: { type: 'node', nodeId: node.origin },
          receiver: {
            name: 'Chioma Okafor',
            phone: '08031234567',
            email: `buyer+${randomUUID().slice(0, 6)}@${DOMAIN}`,
          },
          parcel: { description: 'Earbuds', size: 'small', weightKg: 0.4 },
          ...overrides,
        })
        .expect(201),
    );

  // Courier legs are logistics' business; here the order is moved along
  // directly, exactly as the delivery listener would.
  const step =
    (fn: (orderId: string, manager: never) => Promise<unknown>) =>
    async (orderId: string) =>
      dataSource.transaction((manager) => fn(orderId, manager as never));
  const pickUp = step(async (id, m) => {
    await orders.markCourierAssigned(id, 'test-courier', m);
    await orders.markPickedUpByRider(id, m);
  });
  const arrive = step(async (id, m: never) => {
    await orders.markArrivedAtDestination(id, m);
    // The forward courier leg ends at delivery, as it would for real.
    await (m as unknown as DataSource['manager']).query(
      `UPDATE delivery_legs SET status = 'delivered', "endedAt" = now()
        WHERE "orderId" = $1 AND "legType" = 'forward'`,
      [id],
    );
  });

  async function latestEmailTo(
    to: string,
  ): Promise<{ subject: string; text: string }> {
    const [row] = await dataSource.query<
      { payload: { subject: string; text: string } }[]
    >(
      `SELECT payload FROM outbox_events
        WHERE "eventType" = 'email' AND payload ->> 'to' = $1
        ORDER BY "createdAt" DESC LIMIT 1`,
      [to],
    );
    return row?.payload;
  }
  const codeIn = (text: string): string => /\b(\d{6})\b/.exec(text)![1];

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
    return data<{ id: string }>(
      await http()
        .post('/api/v1/nodes')
        .set('Cookie', admin)
        .send({
          name: `${NODE_PREFIX}${name}`,
          address: `${name} road`,
          city: 'Ibadan',
          state: 'Oyo',
          latitude: 7.5 + offsetKm / 111,
          longitude: 3.95,
          capacity: 50,
          ...NODE_CONTACT_FIELDS,
        })
        .expect(201),
    ).id;
  }

  async function operatorFor(name: string, nodeId: string): Promise<string[]> {
    const user = await makeUser(name, { role: UserRole.NODE_OPERATOR });
    const memberships = app.get<Repository<NodeMembershipEntity>>(
      getRepositoryToken(NodeMembershipEntity),
    );
    await memberships.save(memberships.create({ userId: user.id, nodeId }));
    return signIn(user);
  }

  // Dropped off, carried and checked in at the destination: on the shelf.
  async function onShelf(): Promise<{
    s: Shipment;
    orderId: string;
    email: string;
  }> {
    const email = `buyer+${randomUUID().slice(0, 6)}@${DOMAIN}`;
    const s = await create({
      receiver: { name: 'Chioma Okafor', phone: '08031234567', email },
    });
    const orderId = (await orderOf(s.trackingCode)).id;
    await handoff(originOperator, orderId, 'drop-off').expect(200);
    await pickUp(orderId);
    await arrive(orderId);
    await handoff(destinationOperator, orderId, 'intake').expect(200);
    return { s, orderId, email };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    // The env is read when AppModule is imported, so switch live shipments
    // on at the source (default off).
    const config = app.get(ConfigService);
    const get = config.get.bind(config) as (
      key: string,
      opts?: unknown,
    ) => unknown;
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string, opts?: unknown) =>
        key === 'MERCHANT_LIVE_SHIPMENTS_ENABLED' ? true : get(key, opts),
      );
    users = moduleFixture.get(getRepositoryToken(UserEntity));
    dataSource = moduleFixture.get(DataSource);
    orders = app.get(OrdersService);

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
    await http()
      .post('/api/v1/admin/revenue-split')
      .set('Cookie', admin)
      .send({ riderPercent: 60, nodePercent: 20, platformPercent: 20 })
      .expect(201);
    node.origin = await createNode(admin, 'Origin', 0);
    node.destination = await createNode(admin, 'Destination', 3);
    originOperator = await operatorFor('origin-op', node.origin);
    destinationOperator = await operatorFor('dest-op', node.destination);
    node.elsewhere = await createNode(admin, 'Elsewhere', 9);
    node.northA = await createNode(admin, 'NorthA', 12);
    node.northB = await createNode(admin, 'NorthB', 14);
    elsewhereOperator = await operatorFor('elsewhere-op', node.elsewhere);
    multiNodeOperator = await operatorFor('multi-op', node.northA);
    await app
      .get<Repository<NodeMembershipEntity>>(
        getRepositoryToken(NodeMembershipEntity),
      )
      .save({
        userId: (await users.findOneByOrFail({ email: `multi-op@${DOMAIN}` }))
          .id,
        nodeId: node.northB,
      });

    owner = await signIn(await makeUser('owner'));
    merchantId = data<{ merchant: { id: string } }>(
      await http()
        .post('/api/v1/merchant/account')
        .set('Cookie', owner)
        .send({ type: 'business', tradingName: 'Live Stores' })
        .expect(201),
    ).merchant.id;
    await dataSource.query(
      `UPDATE merchants SET status = 'approved', tier = 'business',
              "contactEmail" = 'ops@${DOMAIN}' WHERE id = $1`,
      [merchantId],
    );
    await dataSource.transaction((manager) =>
      app.get(WalletService).creditExternal(manager, {
        merchantId,
        mode: 'live',
        type: WalletEntryType.TOP_UP,
        amountKobo: FUNDS,
        description: 'Test funding',
        externalRef: `test:${merchantId}`,
      }),
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      const pattern = `%@${DOMAIN}`;
      const ours = `SELECT id FROM orders WHERE "merchantId" = $1`;
      await dataSource.query(
        `DELETE FROM revenue_split_entries WHERE "orderId" IN (${ours})`,
        [merchantId],
      );
      await dataSource.query(
        `DELETE FROM delivery_legs WHERE "orderId" IN (${ours})`,
        [merchantId],
      );
      await dataSource.query(
        `DELETE FROM handoff_codes WHERE "orderId" IN (${ours})`,
        [merchantId],
      );
      await dataSource.query(
        `DELETE FROM order_events WHERE "orderId" IN (${ours})`,
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
      await dataSource.query(
        `DELETE FROM revenue_split_rules WHERE "createdByAdminId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM pricing_rules WHERE "createdByAdminId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      // Bags packed at our hub (M5b), and their courier legs.
      const ourBags = `SELECT id FROM bags WHERE "originNodeId" IN (SELECT id FROM nodes WHERE name LIKE $1)`;
      await dataSource.query(
        `DELETE FROM delivery_legs WHERE "bagId" IN (${ourBags})`,
        [`${NODE_PREFIX}%`],
      );
      await dataSource.query(`DELETE FROM bags WHERE id IN (${ourBags})`, [
        `${NODE_PREFIX}%`,
      ]);
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
  });

  it('creates a real order behind the shipment and holds the fee', async () => {
    const before = await wallet();
    const s = await create();
    expect(s).toMatchObject({ mode: 'live', status: 'created' });
    expect(s.trackingCode).toMatch(/^LCM-/);
    expect(s.trackingUrl).toContain(`/track/${s.trackingCode}?t=`);
    const order = await orderOf(s.trackingCode);
    expect(order).toMatchObject({
      source: 'merchant',
      merchantId,
      consumerId: null,
      status: 'awaiting_drop_off',
      amountKobo: s.fee.quotedKobo,
    });
    expect(await wallet()).toMatchObject({
      balanceKobo: before.balanceKobo,
      heldKobo: before.heldKobo + s.fee.quotedKobo,
    });
  });

  it('charges at drop-off, takes an origin slot, and follows the order to collection', async () => {
    const before = await wallet();
    const slotsBefore = await originCount();
    const email = `buyer+${randomUUID().slice(0, 6)}@${DOMAIN}`;
    const s = await create({
      receiver: { name: 'Chioma Okafor', phone: '08031234567', email },
    });
    const orderId = (await orderOf(s.trackingCode)).id;

    const found = await http()
      .get(`/api/v1/handoffs/orders/by-tracking-code/${s.trackingCode}`)
      .set('Cookie', originOperator)
      .expect(200);
    expect(data<{ id: string }>(found).id).toBe(orderId);
    await handoff(originOperator, orderId, 'drop-off').expect(200);

    expect(await shipment(s.id)).toMatchObject({
      status: 'received',
      fee: { state: 'charged', chargedKobo: s.fee.quotedKobo },
    });
    expect(await wallet()).toMatchObject({
      balanceKobo: before.balanceKobo - s.fee.quotedKobo,
      heldKobo: before.heldKobo,
    });
    expect(await originCount()).toBe(slotsBefore + 1);

    await pickUp(orderId);
    expect((await shipment(s.id)).status).toBe('in_transit');
    await arrive(orderId);
    await handoff(destinationOperator, orderId, 'intake').expect(200);
    const shelved = await shipment(s.id);
    expect(shelved.status).toBe('ready_for_collection');
    expect(shelved.collection.deadline).not.toBeNull();

    const collectionCode = codeIn((await latestEmailTo(email)).text);
    await handoff(destinationOperator, orderId, 'collect', {
      code: collectionCode,
      identityConfirmed: true,
    }).expect(200);
    const collected = await shipment(s.id);
    expect(collected).toMatchObject({
      status: 'collected',
      collection: { method: 'code' },
    });

    const statuses = await dataSource.query<{ type: string }[]>(
      `SELECT type FROM merchant_shipment_events WHERE "shipmentId" = $1 ORDER BY sequence`,
      [s.id],
    );
    expect(statuses.map((e) => e.type)).toEqual([
      'created',
      'received',
      'in_transit',
      'ready_for_collection',
      'collected',
    ]);
    const [split] = await dataSource.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM revenue_split_entries WHERE "orderId" = $1`,
      [orderId],
    );
    expect(split.count).toBeGreaterThan(0);
  });

  it('cancels before drop-off: order cancelled, hold released', async () => {
    const before = await wallet();
    const s = await create();
    await live.post(`/shipments/${s.id}/cancel`).expect(200);
    expect((await shipment(s.id)).status).toBe('cancelled');
    expect((await orderOf(s.trackingCode)).status).toBe('cancelled');
    expect(await wallet()).toMatchObject({
      balanceKobo: before.balanceKobo,
      heldKobo: before.heldKobo,
    });
  });

  it('refuses at the counter without touching the origin slot', async () => {
    const before = await wallet();
    const slots = await originCount();
    const s = await create();
    const orderId = (await orderOf(s.trackingCode)).id;
    await handoff(originOperator, orderId, 'refuse', {
      reason: 'packaging',
    }).expect(200);
    expect(await shipment(s.id)).toMatchObject({
      status: 'refused',
      fee: { state: 'released' },
    });
    expect(await wallet()).toMatchObject({
      balanceKobo: before.balanceKobo,
      heldKobo: before.heldKobo,
    });
    expect(await originCount()).toBe(slots);
  });

  it('sends a shelved parcel straight back on request', async () => {
    const { s, orderId } = await onShelf();
    const back = data<Shipment>(
      await live.post(`/shipments/${s.id}/return-to-sender`).expect(200),
    );
    expect(back).toMatchObject({
      status: 'returning',
      return: { reason: 'merchant_request' },
    });
    const order = await orderOf(s.trackingCode);
    expect(order).toMatchObject({
      status: 'return_initiated',
      returnReason: 'merchant_request',
    });
    const [codes] = await dataSource.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM handoff_codes
        WHERE "orderId" = $1 AND type = 'receiver_collection' AND "usedAt" IS NULL`,
      [orderId],
    );
    expect(codes.count).toBe(0);
    const [leg] = await dataSource.query<{ legType: string }[]>(
      `SELECT "legType" FROM delivery_legs WHERE "orderId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [orderId],
    );
    expect(leg.legType).toBe('return');
  });

  it('turns a recalled parcel round on arrival, then hands it back to the merchant', async () => {
    const email = `buyer+${randomUUID().slice(0, 6)}@${DOMAIN}`;
    const s = await create({
      receiver: { name: 'Chioma Okafor', phone: '08031234567', email },
    });
    const orderId = (await orderOf(s.trackingCode)).id;
    await handoff(originOperator, orderId, 'drop-off').expect(200);
    await pickUp(orderId);

    const recalled = data<Shipment>(
      await live.post(`/shipments/${s.id}/return-to-sender`).expect(200),
    );
    expect(recalled.status).toBe('returning');
    expect((await orderOf(s.trackingCode)).returnRequestedAt).not.toBeNull();
    await live.post(`/shipments/${s.id}/return-to-sender`).expect(409);

    await arrive(orderId);
    const intake = await handoff(destinationOperator, orderId, 'intake').expect(
      200,
    );
    // The counter is told it's going back, not to shelve it for the buyer.
    expect(data<{ status: string }>(intake).status).toBe('return_initiated');
    expect((await orderOf(s.trackingCode)).status).toBe('return_initiated');
    expect((await shipment(s.id)).status).toBe('returning');
    // The buyer was never offered it.
    expect((await latestEmailTo(email))?.subject ?? '').not.toMatch(/ready/i);

    await dataSource.transaction(async (manager) => {
      await orders.markReturnPickedUp(orderId, manager);
      await orders.markReturnedToOrigin(orderId, manager);
    });
    await handoff(originOperator, orderId, 'return-intake').expect(200);
    const ready = await shipment(s.id);
    expect(ready.status).toBe('return_ready');
    expect(ready.return?.readyForCollectionAt).not.toBeNull();

    const notice = await latestEmailTo(`ops@${DOMAIN}`);
    expect(notice.subject).toMatch(/ready for collection/i);
    expect(notice.text).toMatch(/valid until the end of/);
    await handoff(originOperator, orderId, 'return-collect', {
      code: codeIn(notice.text),
      identityConfirmed: true,
    }).expect(200);
    expect((await shipment(s.id)).status).toBe('returned');

    const types = await dataSource.query<{ type: string }[]>(
      `SELECT type FROM merchant_shipment_events WHERE "shipmentId" = $1 ORDER BY sequence`,
      [s.id],
    );
    expect(types.map((e) => e.type)).toEqual([
      'created',
      'received',
      'in_transit',
      'returning',
      'return_ready',
      'returned',
    ]);
  });

  it('sends a fresh code to a new receiver contact while on the shelf', async () => {
    const { s } = await onShelf();
    const newEmail = `new+${randomUUID().slice(0, 6)}@${DOMAIN}`;
    await live
      .patch(`/shipments/${s.id}`, { receiver: { email: newEmail } })
      .expect(200);
    const sent = await latestEmailTo(newEmail);
    expect(codeIn(sent.text)).toMatch(/^\d{6}$/);
  });

  it('expires shipments never dropped off', async () => {
    const before = await wallet();
    const s = await create();
    await dataSource.query(
      `UPDATE merchant_shipments SET "dropDeadline" = now() - interval '1 minute' WHERE id = $1`,
      [s.id],
    );
    expect(await app.get(ShipmentExpiryService).run()).toBeGreaterThanOrEqual(
      1,
    );
    expect((await shipment(s.id)).status).toBe('expired');
    expect((await orderOf(s.trackingCode)).status).toBe('cancelled');
    expect(await wallet()).toMatchObject({
      balanceKobo: before.balanceKobo,
      heldKobo: before.heldKobo,
    });
  });

  it('enforces the live rules: relay, daily limit, paused creation', async () => {
    const relay = await live
      .post('/shipments', {
        reference: `L-${randomUUID().slice(0, 8)}`,
        destinationNodeId: node.destination,
        origin: { type: 'node', nodeId: node.origin },
        receiver: {
          name: 'Ada Buyer',
          phone: '08031234567',
          email: `a@${DOMAIN}`,
        },
        parcel: { description: 'Box', size: 'small' },
        notifyReceiver: 'merchant',
      })
      .expect(422);
    expect(code(relay)).toBe('RECEIVER_RELAY_NOT_ENABLED');

    const [{ count }] = await dataSource.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM merchant_shipments WHERE "merchantId" = $1 AND mode = 'live'`,
      [merchantId],
    );
    await dataSource.query(
      `UPDATE merchants SET "limitOverrides" = $2::jsonb WHERE id = $1`,
      [merchantId, JSON.stringify({ liveShipmentsPerDay: count })],
    );
    expect(
      code(
        await live
          .post('/shipments', {
            reference: `L-${randomUUID().slice(0, 8)}`,
            destinationNodeId: node.destination,
            origin: { type: 'node', nodeId: node.origin },
            receiver: {
              name: 'Ada Buyer',
              phone: '08031234567',
              email: `a@${DOMAIN}`,
            },
            parcel: { description: 'Box', size: 'small' },
          })
          .expect(429),
      ),
    ).toBe('DAILY_LIMIT_REACHED');

    await dataSource.query(
      `UPDATE merchants SET "limitOverrides" = NULL, "creationPaused" = true WHERE id = $1`,
      [merchantId],
    );
    expect(
      code(
        await live
          .post('/shipments', {
            reference: `L-${randomUUID().slice(0, 8)}`,
            destinationNodeId: node.destination,
            origin: { type: 'node', nodeId: node.origin },
            receiver: {
              name: 'Ada Buyer',
              phone: '08031234567',
              email: `a@${DOMAIN}`,
            },
            parcel: { description: 'Box', size: 'small' },
          })
          .expect(403),
      ),
    ).toBe('SHIPMENT_CREATION_PAUSED');
    await dataSource.query(
      `UPDATE merchants SET "creationPaused" = false WHERE id = $1`,
      [merchantId],
    );
  });

  describe('volume discounts (M4e)', () => {
    afterAll(async () => {
      await dataSource.query(
        `UPDATE merchants SET "discountPercentOverride" = NULL WHERE id = $1`,
        [merchantId],
      );
      app.get(MerchantPricingService).forget(merchantId);
    });

    it('takes the discount off the price and only out of the platform share', async () => {
      const undiscounted = await create();
      await dataSource.query(
        `UPDATE merchants SET "discountPercentOverride" = 10 WHERE id = $1`,
        [merchantId],
      );
      app.get(MerchantPricingService).forget(merchantId);

      expect(
        data<{ percent: number; source: string }>(
          await live.get('/pricing').expect(200),
        ),
      ).toMatchObject({ percent: 10, source: 'negotiated' });

      const email = `disc+${randomUUID().slice(0, 6)}@${DOMAIN}`;
      const s = await create({
        receiver: { name: 'Disc Buyer', phone: '08031234567', email },
      });
      expect(s.fee.quotedKobo).toBeLessThan(undiscounted.fee.quotedKobo);
      const order = await dataSource.query<
        {
          id: string;
          amountKobo: number;
          discountKobo: number;
          destinationFeeKobo: number;
        }[]
      >(
        `SELECT id, "amountKobo", "discountKobo", "destinationFeeKobo" FROM orders WHERE "trackingCode" = $1`,
        [s.trackingCode],
      );
      const {
        id: orderId,
        amountKobo,
        discountKobo,
        destinationFeeKobo,
      } = order[0];
      expect(discountKobo).toBeGreaterThan(0);
      expect(amountKobo + discountKobo).toBe(undiscounted.fee.quotedKobo);

      await handoff(originOperator, orderId, 'drop-off').expect(200);
      await pickUp(orderId);
      await arrive(orderId);
      await handoff(destinationOperator, orderId, 'intake').expect(200);
      await handoff(destinationOperator, orderId, 'collect', {
        code: codeIn((await latestEmailTo(email)).text),
        identityConfirmed: true,
      }).expect(200);

      const entries = await dataSource.query<
        { partyType: string; amountKobo: number }[]
      >(
        `SELECT "partyType", "amountKobo" FROM revenue_split_entries WHERE "orderId" = $1`,
        [orderId],
      );
      const by = Object.fromEntries(
        entries.map((e) => [e.partyType, Number(e.amountKobo)]),
      );
      const base = amountKobo + discountKobo - destinationFeeKobo;
      const courierShare = by.rider ?? by.courier_allocation;
      // Rider and Node are paid on the undiscounted fee (60% / 20%)...
      expect(Math.abs(courierShare - base * 0.6)).toBeLessThanOrEqual(1);
      expect(Math.abs(by.node - base * 0.2)).toBeLessThanOrEqual(1);
      // ...the platform share pays for the discount...
      expect(by.platform).toBe(base - courierShare - by.node - discountKobo);
      // ...and everything adds up to what the merchant paid.
      expect(Object.values(by).reduce((sum, value) => sum + value, 0)).toBe(
        amountKobo,
      );
    });
  });

  describe('relaying collection codes (M4d)', () => {
    // The newest event of this type for the shipment; with withCode, the
    // newest one carrying a collection code.
    const latestWebhook = async (
      type: string,
      shipmentId: string,
      withCode = false,
    ) => {
      const rows = await dataSource.query<{ body: string }[]>(
        `SELECT body FROM webhook_events
          WHERE "merchantId" = $1 AND mode = 'live' AND type = $2
          ORDER BY "createdAt" DESC`,
        [merchantId, type],
      );
      return rows
        .map((r) => JSON.parse(r.body) as { data: Record<string, unknown> })
        .find(
          (b) =>
            (b.data.shipment as { id: string } | undefined)?.id ===
              shipmentId &&
            (!withCode || typeof b.data.collectionCode === 'string'),
        );
    };
    const drive = async (s: Shipment) => {
      const orderId = (await orderOf(s.trackingCode)).id;
      await handoff(originOperator, orderId, 'drop-off').expect(200);
      await pickUp(orderId);
      await arrive(orderId);
      await handoff(destinationOperator, orderId, 'intake').expect(200);
      return orderId;
    };

    beforeAll(async () => {
      await dataSource.query(
        `UPDATE merchants SET "receiverCodeRelay" = true WHERE id = $1`,
        [merchantId],
      );
    });

    it('sends the code only to the merchant, who relays it to the buyer', async () => {
      const s = await create({
        receiver: { name: 'Relay Buyer', phone: '08039990001' },
        notifyReceiver: 'merchant',
      });
      const orderId = await drive(s);
      expect((await shipment(s.id)).status).toBe('ready_for_collection');

      const ready = await latestWebhook('shipment.ready_for_collection', s.id);
      const collectionCode = ready?.data.collectionCode as string;
      expect(collectionCode).toMatch(/^\d{6}$/);
      // Nothing from us to the buyer.
      const [{ count }] = await dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM outbox_events
          WHERE payload::text LIKE '%' || $1 || '%' AND "eventType" IN ('email', 'sms')`,
        [s.trackingCode],
      );
      expect(count).toBe(0);
      // The code is never stored on the shipment's history.
      const [stored] = await dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM merchant_shipment_events
          WHERE "shipmentId" = $1 AND data::text LIKE '%' || $2 || '%'`,
        [s.id, collectionCode],
      );
      expect(stored.count).toBe(0);

      // A new receiver phone: a fresh code, relayed as shipment.updated.
      await live
        .patch(`/shipments/${s.id}`, { receiver: { phone: '08039990002' } })
        .expect(200);
      const updated = await latestWebhook('shipment.updated', s.id, true);
      expect(updated?.data).toMatchObject({ changed: ['collectionCode'] });
      const replacement = updated?.data.collectionCode as string;
      expect(replacement).toMatch(/^\d{6}$/);

      await handoff(destinationOperator, orderId, 'collect', {
        code: replacement,
        identityConfirmed: true,
      }).expect(200);
      expect((await shipment(s.id)).status).toBe('collected');
    });

    it('with both, the buyer and the merchant get the same code', async () => {
      const email = `both+${randomUUID().slice(0, 6)}@${DOMAIN}`;
      const s = await create({
        receiver: { name: 'Both Buyer', phone: '08039990003', email },
        notifyReceiver: 'both',
      });
      await drive(s);
      const ready = await latestWebhook('shipment.ready_for_collection', s.id);
      expect(codeIn((await latestEmailTo(email)).text)).toBe(
        ready?.data.collectionCode,
      );
    });
  });

  describe('drop-off at another Node and re-pricing (M4c2)', () => {
    it("refuses a merchant parcel at a private Node (it serves only its owner's parcels)", async () => {
      const s = await create();
      const orderId = (await orderOf(s.trackingCode)).id;
      await dataSource.query(
        `UPDATE nodes SET "isPubliclyVisible" = false WHERE id = $1`,
        [node.elsewhere],
      );
      try {
        const refused = await handoff(
          elsewhereOperator,
          orderId,
          'drop-off',
        ).expect(422);
        expect(code(refused)).toBe('PRIVATE_NODE_DROP_OFF');
      } finally {
        await dataSource.query(
          `UPDATE nodes SET "isPubliclyVisible" = true WHERE id = $1`,
          [node.elsewhere],
        );
      }
      await live.post(`/shipments/${s.id}/cancel`).expect(200);
    });

    it('re-homes a parcel dropped at another Node and charges the re-priced fee', async () => {
      const before = await wallet();
      const declaredSlots = await originCount();
      const s = await create();
      const orderId = (await orderOf(s.trackingCode)).id;

      const scan = data<{
        myRole: string;
        nextAction: string;
        droppingOffElsewhere: boolean;
        originNodeName: string;
      }>(
        await http()
          .get(`/api/v1/handoffs/orders/by-tracking-code/${s.trackingCode}`)
          .set('Cookie', elsewhereOperator)
          .expect(200),
      );
      expect(scan).toMatchObject({
        myRole: 'origin',
        nextAction: 'confirm_drop_off',
        droppingOffElsewhere: true,
        originNodeName: `${NODE_PREFIX}Origin`,
      });

      const dropped = await handoff(elsewhereOperator, orderId, 'drop-off', {
        measured: { weightKg: 0.5 },
      }).expect(200);
      expect(data<{ originNodeId: string }>(dropped).originNodeId).toBe(
        node.elsewhere,
      );

      const after = await shipment(s.id);
      expect(after.status).toBe('received');
      const order = await orderOf(s.trackingCode);
      expect(order.originNodeId).toBe(node.elsewhere);
      expect(order.amountKobo).toBe(after.fee.chargedKobo);
      expect(after.fee.chargedKobo).not.toBe(s.fee.quotedKobo);
      expect(await wallet()).toMatchObject({
        balanceKobo: before.balanceKobo - after.fee.chargedKobo!,
        heldKobo: before.heldKobo,
      });
      // The slot is taken where the parcel actually is.
      expect(await originCount()).toBe(declaredSlots);

      const events = await dataSource.query<
        { type: string; data: Record<string, unknown> | null }[]
      >(
        `SELECT type, data FROM merchant_shipment_events WHERE "shipmentId" = $1 ORDER BY sequence`,
        [s.id],
      );
      expect(events.map((e) => e.type)).toEqual([
        'created',
        'received',
        'fee_adjusted',
      ]);
      expect(events[1].data).toMatchObject({
        previousOrigin: { nodeId: node.origin },
      });
      expect(events[2].data).toMatchObject({
        adjustment: {
          previousKobo: s.fee.quotedKobo,
          newKobo: after.fee.chargedKobo,
          reason: 'measured_and_dropped_elsewhere',
        },
      });
      // The dashboard sees the same details on the timeline.
      const timeline = data<{ type: string; data: unknown }[]>(
        await live.get(`/shipments/${s.id}/timeline`).expect(200),
      );
      expect(timeline[1]).toMatchObject({
        type: 'received',
        data: { previousOrigin: { nodeId: node.origin } },
      });
      expect(timeline[2]).toMatchObject({
        type: 'fee_adjusted',
        data: { adjustment: { reason: 'measured_and_dropped_elsewhere' } },
      });
    });

    it('records what the counter measured at the declared Node', async () => {
      const s = await create();
      const orderId = (await orderOf(s.trackingCode)).id;
      await handoff(originOperator, orderId, 'drop-off', {
        measured: { weightKg: 0.9, size: 'small' },
      }).expect(200);
      const order = await dataSource.query<{ measured: unknown }[]>(
        `SELECT measured FROM orders WHERE id = $1`,
        [orderId],
      );
      expect(order[0].measured).toEqual({ weightKg: 0.9, size: 'small' });
      const received = data<{ parcel: { measured: unknown } }>(
        await live.get(`/shipments/${s.id}`).expect(200),
      );
      expect(received.parcel.measured).toEqual({
        weightKg: 0.9,
        size: 'small',
      });
    });

    it('asks which Node when the staff member works at several, and never at the destination', async () => {
      const s = await create();
      const orderId = (await orderOf(s.trackingCode)).id;
      expect(
        code(await handoff(multiNodeOperator, orderId, 'drop-off').expect(422)),
      ).toBe('DROP_OFF_NODE_REQUIRED');
      expect(
        code(
          await handoff(destinationOperator, orderId, 'drop-off').expect(422),
        ),
      ).toBe('DROP_OFF_AT_DESTINATION');
      await handoff(multiNodeOperator, orderId, 'drop-off', {
        nodeId: node.northB,
      }).expect(200);
      expect((await orderOf(s.trackingCode)).originNodeId).toBe(node.northB);
    });

    it('validates measurements', async () => {
      const s = await create();
      const orderId = (await orderOf(s.trackingCode)).id;
      await handoff(originOperator, orderId, 'drop-off', {
        measured: { lengthCm: 20 },
      }).expect(400);
    });
  });

  describe('claims (M4f1)', () => {
    let opsAdmin: string[];
    let financeMaker: string[];
    let financeChecker: string[];
    const admin = (cookie: string[]) => ({
      get: (url: string) =>
        http().get(`/api/v1/admin${url}`).set('Cookie', cookie),
      post: (url: string, body: object = {}) =>
        http().post(`/api/v1/admin${url}`).set('Cookie', cookie).send(body),
    });
    interface Claim {
      id: string;
      source: string;
      status: string;
      maxPayoutKobo: number;
      payoutKobo: number | null;
      decisionNote: string | null;
      pendingPayoutApprovalId?: string | null;
    }

    beforeAll(async () => {
      const adminUser = (name: string, permissions: AdminPermission[]) =>
        makeUser(name, { role: UserRole.ADMIN, adminPermissions: permissions });
      opsAdmin = await signIn(
        await adminUser('claims-ops', [AdminPermission.OPS]),
      );
      financeMaker = await signIn(
        await adminUser('claims-finance', [AdminPermission.FINANCE]),
      );
      financeChecker = await signIn(
        await adminUser('claims-checker', [AdminPermission.FINANCE]),
      );
    });

    afterAll(async () => {
      await dataSource.query(
        `DELETE FROM approval_requests WHERE "requestedByUserId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [`claims-%@${DOMAIN}`],
      );
    });

    it('opens a claim for a parcel lost in our care and pays it after two finance admins', async () => {
      const s = await create({
        parcel: {
          description: 'Phone',
          size: 'small',
          weightKg: 0.4,
          declaredValueKobo: 3_000_000,
        },
      });
      const orderId = (await orderOf(s.trackingCode)).id;
      await handoff(originOperator, orderId, 'drop-off').expect(200);
      await pickUp(orderId);
      await admin(opsAdmin)
        .post(`/orders/${orderId}/exception`, {
          type: 'lost',
          note: 'Rider reports the parcel fell off the bike',
        })
        .expect(200);

      const after = await shipment(s.id);
      expect(after.status).toBe('exception');
      const claimId = after.exception!.claimId!;
      expect(
        data<Claim>(await live.get(`/claims/${claimId}`).expect(200)),
      ).toMatchObject({
        source: 'exception',
        status: 'open',
        maxPayoutKobo: 3_000_000,
      });
      expect(
        code(
          await live
            .post('/claims', {
              shipmentId: s.id,
              type: 'lost',
              description: 'Never arrived at the Node.',
            })
            .expect(409),
        ),
      ).toBe('CLAIM_ALREADY_OPEN');

      const payout = (cookie: string[], amountKobo: number) =>
        admin(cookie).post(`/merchant-claims/${claimId}/payout`, {
          amountKobo,
          merchantNote: 'Declared value refunded.',
          reason: 'Rider confirmed the loss',
        });
      expect(code(await payout(opsAdmin, 3_000_000).expect(403))).toBe(
        'FORBIDDEN',
      );
      expect(code(await payout(financeMaker, 3_000_001).expect(422))).toBe(
        'CLAIM_PAYOUT_TOO_HIGH',
      );
      const requested = data<{ approvalId: string; summary: string }>(
        await payout(financeMaker, 3_000_000).expect(201),
      );
      expect(requested.summary).toContain('lost claim');
      expect(code(await payout(financeMaker, 3_000_000).expect(409))).toBe(
        'CLAIM_PAYOUT_PENDING',
      );
      expect(
        code(
          await admin(opsAdmin)
            .post(`/merchant-claims/${claimId}/reject`, { merchantNote: 'No.' })
            .expect(409),
        ),
      ).toBe('CLAIM_PAYOUT_PENDING');
      expect(
        data<Claim>(
          await admin(opsAdmin).get(`/merchant-claims/${claimId}`).expect(200),
        ).pendingPayoutApprovalId,
      ).toBe(requested.approvalId);

      const before = (await wallet()).balanceKobo;
      await admin(financeChecker)
        .post(`/approvals/${requested.approvalId}/approve`)
        .expect(200);
      expect((await wallet()).balanceKobo).toBe(before + 3_000_000);
      expect(
        data<Claim>(await live.get(`/claims/${claimId}`).expect(200)),
      ).toMatchObject({
        status: 'approved',
        payoutKobo: 3_000_000,
        decisionNote: 'Declared value refunded.',
      });
    });

    it('rejects a merchant claim with a note, and the merchant can file again', async () => {
      const s = await create();
      const orderId = (await orderOf(s.trackingCode)).id;
      await handoff(originOperator, orderId, 'drop-off').expect(200);
      const claim = data<Claim>(
        await live
          .post('/claims', {
            shipmentId: s.id,
            type: 'damaged',
            description: 'Box arrived wet at the Node.',
          })
          .expect(201),
      );
      expect(claim).toMatchObject({ source: 'merchant', status: 'open' });

      await http()
        .patch(`/api/v1/admin/merchant-claims/${claim.id}`)
        .set('Cookie', opsAdmin)
        .send({ internalNote: 'Node photos show a dry box.' })
        .expect(200);
      const queue = data<{ items: Claim[] }>(
        await admin(opsAdmin)
          .get(`/merchant-claims?status=open&merchantId=${merchantId}`)
          .expect(200),
      );
      expect(queue.items.map((c) => c.id)).toContain(claim.id);

      const rejected = data<Claim>(
        await admin(opsAdmin)
          .post(`/merchant-claims/${claim.id}/reject`, {
            merchantNote: 'The Node photographed it dry at drop-off.',
          })
          .expect(200),
      );
      expect(rejected).toMatchObject({
        status: 'rejected',
        decisionNote: 'The Node photographed it dry at drop-off.',
      });
      await live
        .post('/claims', {
          shipmentId: s.id,
          type: 'damaged',
          description: 'New photos from the buyer attached.',
        })
        .expect(201);
    });
  });

  describe('return batches (M4f2)', () => {
    interface Batch {
      id: string;
      reference: string;
      status: string;
      code: string | null;
      shipments: { id: string; status: string; collectedAt: string | null }[];
    }
    interface NodeBatch {
      reference: string;
      merchantName: string;
      status: string;
      parcels: {
        trackingCode: string;
        shelfNumber: number | null;
        waiting: boolean;
      }[];
    }
    const counter = (cookie: string[]) => ({
      get: (url: string) =>
        http()
          .get(`/api/v1/handoffs/return-batches${url}`)
          .set('Cookie', cookie),
      post: (url: string, body: object) =>
        http()
          .post(`/api/v1/handoffs/return-batches${url}`)
          .set('Cookie', cookie)
          .set('X-Locoomo-Client', 'web')
          .send(body),
    });

    // A live parcel recalled in transit, turned round and shelved back at
    // its origin: waiting for the merchant.
    async function returnReady(): Promise<{ s: Shipment; orderId: string }> {
      const s = await create();
      const orderId = (await orderOf(s.trackingCode)).id;
      await handoff(originOperator, orderId, 'drop-off').expect(200);
      await pickUp(orderId);
      await live.post(`/shipments/${s.id}/return-to-sender`).expect(200);
      await arrive(orderId);
      await handoff(destinationOperator, orderId, 'intake').expect(200);
      await dataSource.transaction(async (manager) => {
        await orders.markReturnPickedUp(orderId, manager);
        await orders.markReturnedToOrigin(orderId, manager);
      });
      await handoff(originOperator, orderId, 'return-intake').expect(200);
      expect((await shipment(s.id)).status).toBe('return_ready');
      return { s, orderId };
    }

    it('charges storage for a return left waiting, then disposes of it (M6a)', async () => {
      const { s: parcel, orderId } = await returnReady();
      const storage = app.get(ReturnStorageService);
      await storage.run();
      const [row] = await dataSource.query<
        { storageFeesFrom: Date; disposeAt: Date }[]
      >(
        `SELECT "storageFeesFrom", "disposeAt" FROM merchant_shipments WHERE id = $1`,
        [parcel.id],
      );
      expect(row.storageFeesFrom.getTime()).toBeGreaterThan(Date.now());
      const view = data<
        Shipment & { return: { storageFeesFrom: string; disposeAt: string } }
      >(await live.get(`/shipments/${parcel.id}`).expect(200));
      expect(view.return).toMatchObject({
        storageFeesFrom: row.storageFeesFrom.toISOString(),
        disposeAt: row.disposeAt.toISOString(),
      });

      const entries = async () =>
        (
          await dataSource.query<{ count: number; total: number }[]>(
            `SELECT count(*)::int AS count, coalesce(sum("amountKobo"), 0)::int AS total
               FROM wallet_entries WHERE "shipmentId" = $1 AND type = 'storage_fee'`,
            [parcel.id],
          )
        )[0];
      // A day and a bit into storage: two Lagos days charged, once each.
      const dayTwo = new Date(row.storageFeesFrom.getTime() + 26 * 3_600_000);
      await storage.run(dayTwo);
      const after = await entries();
      expect(after.count).toBeGreaterThanOrEqual(2);
      expect(after.total).toBe(-10_000 * after.count);
      await storage.run(dayTwo);
      expect((await entries()).count).toBe(after.count);
      // To the team (owner, admins, operations), not the contact address.
      expect((await latestEmailTo(`owner@${DOMAIN}`)).subject).toMatch(
        /Storage fees have started/,
      );

      const slotsBefore = await originCount();
      await storage.run(new Date(row.disposeAt.getTime() + 3_600_000));
      expect((await orderOf(parcel.trackingCode)).status).toBe('disposed');
      expect((await shipment(parcel.id)).status).toBe('disposed');
      expect(await originCount()).toBe(slotsBefore - 1);
      const [codes] = await dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM handoff_codes
          WHERE "orderId" = $1 AND type = 'sender_collection' AND "usedAt" IS NULL`,
        [orderId],
      );
      expect(codes.count).toBe(0);
      const [event] = await dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM webhook_events
          WHERE "merchantId" = $1 AND type = 'shipment.disposed' AND body LIKE $2`,
        [merchantId, `%${parcel.id}%`],
      );
      expect(event.count).toBe(1);
      expect((await latestEmailTo(`claims-ops@${DOMAIN}`)).subject).toMatch(
        /abandoned return/,
      );
    });

    it('hands a whole batch back at the Node on one code', async () => {
      const a = await returnReady();
      const b = await returnReady();
      const waiting = data<{ items: { shipmentId: string }[] }>(
        await live
          .get(`/returns?state=ready&nodeId=${node.origin}`)
          .expect(200),
      );
      expect(waiting.items.map((i) => i.shipmentId)).toEqual(
        expect.arrayContaining([a.s.id, b.s.id]),
      );

      const batch = data<Batch>(
        await live
          .post('/return-batches', {
            nodeId: node.origin,
            shipmentIds: [a.s.id, b.s.id],
          })
          .expect(201),
      );
      expect(batch.reference).toMatch(/^RB-/);
      expect(batch.code).toMatch(/^\d{6}$/);

      // Only staff at that Node can see it.
      await counter(destinationOperator).get(`/${batch.reference}`).expect(404);
      const expected = data<NodeBatch[]>(
        await counter(originOperator).get('').expect(200),
      );
      expect(expected.map((x) => x.reference)).toContain(batch.reference);
      const loaded = data<NodeBatch>(
        await counter(originOperator)
          .get(`/${batch.reference.toLowerCase().replace(/-/g, ' ')}`)
          .expect(200),
      );
      expect(loaded.parcels).toHaveLength(2);
      expect(
        loaded.parcels.every((p) => p.waiting && p.shelfNumber !== null),
      ).toBe(true);

      const wrong = batch.code === '000000' ? '111111' : '000000';
      expect(
        code(
          await counter(originOperator)
            .post(`/${batch.reference}/collect`, {
              code: wrong,
              identityConfirmed: true,
            })
            .expect(401),
        ),
      ).toBe('INVALID_HANDOFF_CODE');

      const slotsBefore = await originCount();
      const done = data<NodeBatch>(
        await counter(originOperator)
          .post(`/${batch.reference}/collect`, {
            code: batch.code,
            identityConfirmed: true,
            collectorName: 'Tunde Bakare',
          })
          .expect(200),
      );
      expect(done.status).toBe('collected');
      expect(await originCount()).toBe(slotsBefore - 2);
      expect((await shipment(a.s.id)).status).toBe('returned');
      expect((await shipment(b.s.id)).status).toBe('returned');
      const [codes] = await dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM handoff_codes
          WHERE "orderId" = ANY($1) AND type = 'sender_collection' AND "usedAt" IS NULL`,
        [[a.orderId, b.orderId]],
      );
      expect(codes.count).toBe(0);

      const after = data<Batch>(
        await live.get(`/return-batches/${batch.id}`).expect(200),
      );
      expect(after.status).toBe('collected');
      expect(after.code).toBeNull();
      expect(after.shipments.every((x) => x.collectedAt !== null)).toBe(true);
      expect(
        code(
          await counter(originOperator)
            .post(`/${batch.reference}/collect`, {
              code: batch.code,
              identityConfirmed: true,
            })
            .expect(409),
        ),
      ).toBe('RETURN_BATCH_NOT_OPEN');
    });
  });

  describe('hubs and manifests (M5a)', () => {
    let superAdmin: string[];
    interface Manifest {
      id: string;
      reference: string;
      status: string;
      shipmentCount: number;
      receivedCount: number;
      unexpectedCount: number;
      missingCount: number | null;
    }
    interface Receipt {
      received: number;
      missing: { shipmentId: string }[];
      unexpected: { shipmentId: string }[];
    }
    interface Scan {
      trackingCode: string;
      sortInstruction: string;
      manifest: { reference: string; expected: boolean } | null;
      alreadyReceived: boolean;
    }
    const sandbox = {
      get: (url: string) =>
        http()
          .get(`/api/v1/merchant${url}`)
          .set('Cookie', owner)
          .set('Locoomo-Mode', 'test'),
      post: (url: string, body: object = {}) =>
        http()
          .post(`/api/v1/merchant${url}`)
          .set('Cookie', owner)
          .set('X-Locoomo-Client', 'web')
          .set('Locoomo-Mode', 'test')
          .send(body),
    };
    const hub = (cookie: string[]) => ({
      get: (url: string) =>
        http().get(`/api/v1/handoffs${url}`).set('Cookie', cookie),
      post: (url: string, body: object = {}) =>
        http()
          .post(`/api/v1/handoffs${url}`)
          .set('Cookie', cookie)
          .set('X-Locoomo-Client', 'web')
          .send(body),
    });
    const hubShipment = (
      via: Pick<typeof live, 'post'> = live,
      overrides: Record<string, unknown> = {},
    ) =>
      via
        .post('/shipments', {
          reference: `H-${randomUUID().slice(0, 8)}`,
          destinationNodeId: node.destination,
          origin: { type: 'hub' },
          receiver: {
            name: 'Chioma Okafor',
            phone: '08031234567',
            email: `buyer+${randomUUID().slice(0, 6)}@${DOMAIN}`,
          },
          parcel: { description: 'Earbuds', size: 'small', weightKg: 0.4 },
          ...overrides,
        })
        .expect(201)
        .then((r) => data<Shipment>(r));

    beforeAll(async () => {
      superAdmin = await signIn(
        await makeUser('hub-super', {
          role: UserRole.ADMIN,
          adminPermissions: [AdminPermission.SUPER],
        }),
      );
      const settings = (hubNodeId: string | null) =>
        http()
          .patch(`/api/v1/admin/merchants/${merchantId}/settings`)
          .set('Cookie', superAdmin)
          .send({ hubNodeId });
      expect(code(await settings(node.origin).expect(422))).toBe('NOT_A_HUB');
      await http()
        .patch(`/api/v1/nodes/${node.origin}`)
        .set('Cookie', superAdmin)
        .send({ isHub: true })
        .expect(200);
      await settings(node.origin).expect(200);
    });

    it('ships from the assigned hub by default and quotes from it', async () => {
      const s = await hubShipment();
      expect(s.origin).toMatchObject({ type: 'hub', nodeId: node.origin });
      await live
        .get(`/quotes?destinationNodeId=${node.destination}&parcelSize=small`)
        .expect(200);
    });

    it('checks a truck in against its manifest and reports what was missing', async () => {
      const a = await hubShipment();
      const b = await hubShipment(live, {
        externalBarcode: `XB${randomUUID().slice(0, 10)}`,
      });
      const c = await hubShipment();
      const stray = await hubShipment();

      const manifest = data<Manifest>(
        await live
          .post('/manifests', {
            expectedDropAt: new Date(Date.now() + 3_600_000).toISOString(),
            shipmentIds: [a.id, b.id, c.id],
          })
          .expect(201),
      );
      expect(manifest).toMatchObject({ status: 'open', shipmentCount: 3 });
      const other = data<Manifest>(await live.post('/manifests').expect(201));
      const clash = await live
        .post(`/manifests/${other.id}/shipments`, { shipmentIds: [a.id] })
        .expect(422);
      expect(code(clash)).toBe('MANIFEST_INVALID');
      await live.post(`/manifests/${other.id}/cancel`).expect(200);

      await live.post(`/manifests/${manifest.id}/close`).expect(200);
      expect(
        code(
          await live
            .post(`/manifests/${manifest.id}/shipments`, {
              shipmentIds: [stray.id],
            })
            .expect(409),
        ),
      ).toBe('MANIFEST_NOT_EDITABLE');
      const pdf = await live
        .get(`/manifests/${manifest.id}/document`)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

      // Only the hub's own staff see it.
      await hub(destinationOperator)
        .get(`/manifests/${manifest.reference}`)
        .expect(404);
      const expected = data<{ reference: string }[]>(
        await hub(originOperator).get('/manifests').expect(200),
      );
      expect(expected.map((m) => m.reference)).toContain(manifest.reference);

      const scan = (code_: string) =>
        hub(originOperator).post('/hub-intake', {
          code: code_,
          manifestReference: manifest.reference.toLowerCase(),
        });
      const first = data<Scan>(await scan(a.trackingCode).expect(200));
      expect(first).toMatchObject({
        alreadyReceived: false,
        manifest: { reference: manifest.reference, expected: true },
      });
      expect(first.sortInstruction).toContain('Destination');
      expect((await shipment(a.id)).status).toBe('received');
      expect(
        data<Scan>(await scan(a.trackingCode).expect(200)).alreadyReceived,
      ).toBe(true);
      const byBarcode = data<Scan>(await scan(b.externalBarcode!).expect(200));
      expect(byBarcode.trackingCode).toBe(b.trackingCode);
      const unexpected = data<Scan>(await scan(stray.reference).expect(200));
      expect(unexpected.manifest).toEqual({
        reference: manifest.reference,
        expected: false,
      });
      expect(code(await scan('NOPE-123').expect(404))).toBe('PARCEL_NOT_FOUND');

      const receipt = data<Receipt>(
        await hub(originOperator)
          .post(`/manifests/${manifest.reference}/complete`)
          .expect(200),
      );
      expect(receipt.received).toBe(3);
      expect(receipt.missing.map((m) => m.shipmentId)).toEqual([c.id]);
      expect(receipt.unexpected.map((m) => m.shipmentId)).toEqual([stray.id]);
      expect(
        data<Manifest>(await live.get(`/manifests/${manifest.id}`).expect(200)),
      ).toMatchObject({
        status: 'received',
        receivedCount: 3,
        missingCount: 1,
      });
      const [event] = await dataSource.query<{ body: string }[]>(
        `SELECT body FROM webhook_events WHERE "merchantId" = $1 AND type = 'manifest.received'
          ORDER BY "createdAt" DESC LIMIT 1`,
        [merchantId],
      );
      expect((JSON.parse(event.body) as { data: Receipt }).data).toMatchObject({
        reference: manifest.reference,
        received: 3,
      });
      // The missing one can go on the next truck.
      await live.post('/manifests', { shipmentIds: [c.id] }).expect(201);
    });

    it('simulates a hub check-in in the sandbox', async () => {
      const x = await hubShipment(sandbox);
      const y = await hubShipment(sandbox);
      const m = data<Manifest>(
        await sandbox
          .post('/manifests', { shipmentIds: [x.id, y.id] })
          .expect(201),
      );
      const receipt = data<Receipt>(
        await sandbox
          .post(`/test/manifests/${m.id}/receive`, {
            missingShipmentIds: [y.id],
          })
          .expect(200),
      );
      expect(receipt).toMatchObject({
        received: 1,
        missing: [{ shipmentId: y.id }],
      });
      expect(
        data<Shipment>(await sandbox.get(`/shipments/${x.id}`).expect(200))
          .status,
      ).toBe('received');
    });
  });

  describe('bags (M5b)', () => {
    const COURIER = 'test_bags';
    interface ScanResult {
      sortInstruction: string;
      bag: { code: string; parcelCount: number; sealed: boolean } | null;
    }
    interface Bag {
      code: string;
      status: string;
      parcelCount: number;
      parcels: { trackingCode: string; status: string }[];
    }
    const counter = (cookie: string[]) => ({
      get: (url: string) =>
        http().get(`/api/v1/handoffs${url}`).set('Cookie', cookie),
      post: (url: string, body: object = {}) =>
        http()
          .post(`/api/v1/handoffs${url}`)
          .set('Cookie', cookie)
          .set('X-Locoomo-Client', 'web')
          .send(body),
    });
    const hubParcel = async (destinationNodeId: string) => {
      const s = data<Shipment>(
        await live
          .post('/shipments', {
            reference: `B-${randomUUID().slice(0, 8)}`,
            destinationNodeId,
            origin: { type: 'hub' },
            receiver: {
              name: 'Chioma Okafor',
              phone: '08031234567',
              email: `buyer+${randomUUID().slice(0, 6)}@${DOMAIN}`,
            },
            parcel: { description: 'Earbuds', size: 'small', weightKg: 0.4 },
          })
          .expect(201),
      );
      const scan = data<ScanResult>(
        await counter(originOperator)
          .post('/hub-intake', { code: s.trackingCode })
          .expect(200),
      );
      return { s, orderId: (await orderOf(s.trackingCode)).id, scan };
    };
    // The bag courier reporting progress, as its webhooks would.
    const courierSays = async (bagCode: string, status: string) => {
      const [leg] = await dataSource.query<{ externalId: string }[]>(
        `SELECT l."externalId" FROM delivery_legs l JOIN bags b ON b.id = l."bagId"
          WHERE b.code = $1 AND l.status IN ('requested', 'assigned', 'picked_up')`,
        [bagCode],
      );
      await dataSource.transaction((manager) =>
        app.get(DeliveryEventsService).syncFromSnapshot(
          COURIER,
          {
            externalId: leg.externalId,
            status: status as DeliveryLegStatus,
            providerStatus: status,
            sequence: null,
            courier: { name: 'Bayo', phone: '+2348030000000', vehicle: 'car' },
            trackingUrl: null,
            actualKobo: null,
            surchargeKobo: null,
            failureReason: null,
          },
          manager,
        ),
      );
    };
    const bagStatus = async (code_: string) =>
      (
        await dataSource.query<{ status: string }[]>(
          `SELECT status FROM bags WHERE code = $1`,
          [code_],
        )
      )[0].status;

    beforeAll(async () => {
      app.get(LogisticsProviderRegistry).register({
        key: COURIER,
        capabilities: {
          vehicleClasses: ['bicycle', 'motorbike', 'car', 'van'] as never,
          handover: 'provider_code',
          updates: 'webhook',
          remoteSubmission: false,
          cancellableUntil: 'requested' as never,
          prepaidWallet: false,
          carriesBags: true,
        },
        createDelivery: (request) =>
          Promise.resolve({
            externalId: `ext-${request.legId}`,
            status: 'requested' as DeliveryLegStatus,
            providerStatus: 'pending',
            quotedKobo: 150_000,
            trackingUrl: null,
            etaMinutes: 45,
            distanceMeters: null,
          }),
        cancel: () => Promise.resolve(),
        getHandoverCodes: () =>
          Promise.resolve({ pickupCode: '4321', deliveryCode: '8765' }),
      });
      // After in-house (1000): parcels still go to Locoomo riders; bags
      // only to couriers that carry them.
      await dataSource.query(
        `INSERT INTO logistics_providers (key, label, enabled, priority, "maxAttempts")
         VALUES ($1, 'Test bag courier', true, 2000, 3)`,
        [COURIER],
      );
    });

    afterAll(async () => {
      await dataSource.query(
        `DELETE FROM delivery_legs WHERE "providerKey" = $1`,
        [COURIER],
      );
      await dataSource.query(`DELETE FROM logistics_providers WHERE key = $1`, [
        COURIER,
      ]);
    });

    it('packs hub drop-offs by destination, and moves the bag as one courier job', async () => {
      const a = await hubParcel(node.elsewhere);
      const b = await hubParcel(node.elsewhere);
      const other = await hubParcel(node.northB);
      expect(a.scan.bag?.code).toMatch(/^BAG-/);
      expect(b.scan.bag?.code).toBe(a.scan.bag?.code);
      expect(other.scan.bag?.code).not.toBe(a.scan.bag?.code);
      expect(a.scan.sortInstruction).toContain(a.scan.bag!.code);
      const code_ = a.scan.bag!.code;
      // No courier per parcel: the bag gets one.
      const [legs] = await dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM delivery_legs WHERE "orderId" = ANY($1)`,
        [[a.orderId, b.orderId]],
      );
      expect(legs.count).toBe(0);

      const listed = data<{ code: string }[]>(
        await counter(originOperator).get('/bags?status=open').expect(200),
      );
      expect(listed.map((x) => x.code)).toContain(code_);
      await counter(destinationOperator)
        .post(`/bags/${code_}/seal`)
        .expect(404);
      const sealed = data<Bag>(
        await counter(originOperator)
          .post(`/bags/${code_.toLowerCase()}/seal`)
          .expect(200),
      );
      expect(sealed).toMatchObject({ status: 'sealed', parcelCount: 2 });
      expect(sealed.parcels).toHaveLength(2);
      const [leg] = await dataSource.query<
        { providerKey: string; orderId: string | null; vehicleClass: string }[]
      >(
        `SELECT l."providerKey", l."orderId", l."vehicleClass"
           FROM delivery_legs l JOIN bags b ON b.id = l."bagId" WHERE b.code = $1`,
        [code_],
      );
      expect(leg).toMatchObject({
        providerKey: COURIER,
        orderId: null,
        vehicleClass: 'motorbike',
      });

      await courierSays(code_, 'assigned');
      expect((await orderOf(a.s.trackingCode)).status).toBe('rider_assigned');
      const pickup = data<{ kind: string; pickupCode: string }>(
        await counter(originOperator)
          .get(`/bags/${code_}/courier-handover`)
          .expect(200),
      );
      expect(pickup).toMatchObject({ kind: 'pickup', pickupCode: '4321' });

      const slotsBefore = await originCount();
      await courierSays(code_, 'picked_up');
      expect(await bagStatus(code_)).toBe('in_transit');
      expect(await originCount()).toBe(slotsBefore - 2);
      expect((await shipment(a.s.id)).status).toBe('in_transit');
      expect((await shipment(b.s.id)).status).toBe('in_transit');
      expect(
        data<{ kind: string }>(
          await counter(elsewhereOperator)
            .get(`/bags/${code_}/courier-handover`)
            .expect(200),
        ).kind,
      ).toBe('delivery');

      await courierSays(code_, 'delivered');
      expect(await bagStatus(code_)).toBe('arrived');
      expect((await orderOf(b.s.trackingCode)).status).toBe(
        'arrived_at_destination',
      );

      await handoff(elsewhereOperator, a.orderId, 'intake').expect(200);
      expect(await bagStatus(code_)).toBe('arrived');
      await handoff(elsewhereOperator, b.orderId, 'intake').expect(200);
      expect(await bagStatus(code_)).toBe('unpacked');
      expect((await shipment(b.s.id)).status).toBe('ready_for_collection');
    });

    describe('reroutes, arrival caps and reverse bags (M5c)', () => {
      let rerouteOps: string[];
      let rerouteSuper: string[];
      interface QueueItem {
        orderId: string;
        state: string;
        auto: boolean;
        candidates: { nodeId: string }[];
      }
      const orderRow = async (trackingCode: string) =>
        (
          await dataSource.query<
            {
              id: string;
              rerouteState: string;
              rerouteAuto: boolean;
              destinationNodeId: string;
              destinationSlotHeld: boolean;
              bagId: string | null;
              status: string;
            }[]
          >(
            `SELECT id, "rerouteState", "rerouteAuto", "destinationNodeId",
                    "destinationSlotHeld", "bagId", status
               FROM orders WHERE "trackingCode" = $1`,
            [trackingCode],
          )
        )[0];
      // Full: whatever it holds now is its capacity, so the next parcel
      // addressed to it overflows.
      const fill = (nodeId: string) =>
        dataSource.query(
          `UPDATE nodes SET capacity = GREATEST("currentCount" + "destinationHeldCount", 1)
            WHERE id = $1`,
          [nodeId],
        );
      const toFull = async () => {
        await fill(node.northB);
        const s = await create({ destinationNodeId: node.northB });
        await handoff(
          originOperator,
          (await orderOf(s.trackingCode)).id,
          'drop-off',
        ).expect(200);
        return s;
      };

      beforeAll(async () => {
        rerouteOps = await signIn(
          await makeUser('reroute-ops', {
            role: UserRole.ADMIN,
            adminPermissions: [AdminPermission.OPS],
          }),
        );
        rerouteSuper = await signIn(
          await makeUser('reroute-super', {
            role: UserRole.ADMIN,
            adminPermissions: [AdminPermission.SUPER],
          }),
        );
        // Plenty of room everywhere else, whatever earlier tests left.
        await dataSource.query(
          `UPDATE nodes SET capacity = 1000 WHERE name LIKE $1 AND id <> $2`,
          [`${NODE_PREFIX}%`, node.northB],
        );
      });

      it('holds a parcel for a full destination until ops pick another Node', async () => {
        const s = await toFull();
        const waiting = await orderRow(s.trackingCode);
        expect(waiting).toMatchObject({
          rerouteState: 'pending',
          destinationSlotHeld: false,
          bagId: null,
          status: 'parcel_received_at_origin',
        });
        const [legs] = await dataSource.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM delivery_legs WHERE "orderId" = $1`,
          [waiting.id],
        );
        expect(legs.count).toBe(0);

        const queue = data<QueueItem[]>(
          await http()
            .get('/api/v1/admin/reroutes')
            .set('Cookie', rerouteOps)
            .expect(200),
        );
        const item = queue.find((q) => q.orderId === waiting.id)!;
        expect(item.candidates.length).toBeGreaterThan(0);
        const target = item.candidates[0].nodeId;
        expect(target).not.toBe(node.northB);

        await http()
          .post(`/api/v1/admin/reroutes/${waiting.id}`)
          .set('Cookie', rerouteOps)
          .send({ destinationNodeId: target, reason: 'Yaba is full this week' })
          .expect(200);
        const moved = await orderRow(s.trackingCode);
        expect(moved).toMatchObject({
          rerouteState: 'resolved',
          rerouteAuto: false,
          destinationNodeId: target,
          destinationSlotHeld: true,
        });
        // From the hub it travels in the bag for its new destination.
        expect(moved.bagId).not.toBeNull();
        const after = data<
          Shipment & { destination: { nodeId: string; changed: boolean } }
        >(await live.get(`/shipments/${s.id}`).expect(200));
        expect(after.destination).toMatchObject({
          nodeId: target,
          changed: true,
        });
        const [event] = await dataSource.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM webhook_events
            WHERE "merchantId" = $1 AND type = 'shipment.destination_changed'
              AND body LIKE $2`,
          [merchantId, `%${s.id}%`],
        );
        expect(event.count).toBe(1);
        expect(
          code(
            await http()
              .post(`/api/v1/admin/reroutes/${waiting.id}`)
              .set('Cookie', rerouteOps)
              .send({ destinationNodeId: target, reason: 'again' })
              .expect(409),
          ),
        ).toBe('REROUTE_NOT_PENDING');
      });

      it('picks the nearest Node with room after a working day without a decision', async () => {
        const s = await toFull();
        const waiting = await orderRow(s.trackingCode);
        await dataSource.query(
          `UPDATE orders SET "rerouteRequestedAt" = now() - interval '5 days' WHERE id = $1`,
          [waiting.id],
        );
        expect(
          (await app.get(RerouteService).run()).rerouted,
        ).toBeGreaterThanOrEqual(1);
        const moved = await orderRow(s.trackingCode);
        expect(moved).toMatchObject({
          rerouteState: 'resolved',
          rerouteAuto: true,
        });
        const review = data<QueueItem[]>(
          await http()
            .get('/api/v1/admin/reroutes?state=auto')
            .set('Cookie', rerouteOps)
            .expect(200),
        );
        expect(review.map((q) => q.orderId)).toContain(waiting.id);
        await dataSource.query(
          `UPDATE nodes SET capacity = 1000 WHERE id = $1`,
          [node.northB],
        );
      });

      it('caps live merchant parcels a day addressed to a small Node', async () => {
        const [today] = await dataSource.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM merchant_shipments
            WHERE mode = 'live' AND destination->>'nodeId' = $1
              AND "createdAt" >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'`,
          [node.northA],
        );
        const cap = (value: number | null) =>
          http()
            .patch(`/api/v1/nodes/${node.northA}`)
            .set('Cookie', rerouteSuper)
            .send({ merchantDailyArrivalCap: value })
            .expect(200);
        await cap(today.count);
        expect(
          code(
            await live
              .post('/shipments', {
                reference: `CAP-${randomUUID().slice(0, 8)}`,
                destinationNodeId: node.northA,
                origin: { type: 'node', nodeId: node.origin },
                receiver: {
                  name: 'Chioma Okafor',
                  phone: '08031234567',
                  email: `c@${DOMAIN}`,
                },
                parcel: {
                  description: 'Earbuds',
                  size: 'small',
                  weightKg: 0.4,
                },
              })
              .expect(422),
          ),
        ).toBe('DESTINATION_NODE_UNAVAILABLE');
        await cap(null);
        await create({ destinationNodeId: node.northA });
      });

      it('sends a merchant return back to its hub in a reverse bag', async () => {
        const { s, orderId } = await onShelf();
        await live.post(`/shipments/${s.id}/return-to-sender`).expect(200);
        const returning = await orderRow(s.trackingCode);
        expect(returning.status).toBe('return_initiated');
        const [bag] = await dataSource.query<
          {
            code: string;
            direction: string;
            originNodeId: string;
            destinationNodeId: string;
          }[]
        >(
          `SELECT code, direction, "originNodeId", "destinationNodeId" FROM bags WHERE id = $1`,
          [returning.bagId],
        );
        expect(bag).toMatchObject({
          direction: 'return',
          originNodeId: node.destination,
          destinationNodeId: node.origin,
        });
        const [ownLegs] = await dataSource.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM delivery_legs WHERE "orderId" = $1 AND "legType" = 'return'`,
          [orderId],
        );
        expect(ownLegs.count).toBe(0);

        await counter(destinationOperator)
          .post(`/bags/${bag.code}/seal`)
          .expect(200);
        const [leg] = await dataSource.query<{ legType: string }[]>(
          `SELECT l."legType" FROM delivery_legs l JOIN bags b ON b.id = l."bagId" WHERE b.code = $1`,
          [bag.code],
        );
        expect(leg.legType).toBe('return');
        await courierSays(bag.code, 'assigned');
        await courierSays(bag.code, 'picked_up');
        expect((await orderRow(s.trackingCode)).status).toBe(
          'return_in_transit',
        );
        await courierSays(bag.code, 'delivered');
        expect((await orderRow(s.trackingCode)).status).toBe(
          'returned_to_origin',
        );
        expect(await bagStatus(bag.code)).toBe('arrived');
        await handoff(originOperator, orderId, 'return-intake').expect(200);
        expect(await bagStatus(bag.code)).toBe('unpacked');
        expect((await shipment(s.id)).status).toBe('return_ready');
      });
    });

    it('flags parcels still missing a day after their bag arrived', async () => {
      const lone = await hubParcel(node.northA);
      const code_ = lone.scan.bag!.code;
      await counter(originOperator).post(`/bags/${code_}/seal`).expect(200);
      await courierSays(code_, 'assigned');
      await courierSays(code_, 'picked_up');
      await courierSays(code_, 'delivered');
      await dataSource.query(
        `UPDATE bags SET "arrivedAt" = now() - interval '25 hours' WHERE code = $1`,
        [code_],
      );
      const run = await app.get(BagService).run();
      expect(run.missingAlerts).toBeGreaterThanOrEqual(1);
      const notice = await latestEmailTo(`claims-ops@${DOMAIN}`);
      expect(notice.subject).toContain(`Missing from bag ${code_}`);
      expect((await app.get(BagService).run()).missingAlerts).toBe(0);
    });
  });

  describe('ops views (M6b)', () => {
    let opsViewer: string[];
    let financeViewer: string[];
    const asAdmin = (cookie: string[], url: string) =>
      http().get(`/api/v1/admin${url}`).set('Cookie', cookie);

    beforeAll(async () => {
      opsViewer = await signIn(
        await makeUser('ops-views', {
          role: UserRole.ADMIN,
          adminPermissions: [AdminPermission.OPS],
        }),
      );
      financeViewer = await signIn(
        await makeUser('finance-views', {
          role: UserRole.ADMIN,
          adminPermissions: [AdminPermission.FINANCE],
        }),
      );
    });

    it('lists and opens orders across consumers and merchants', async () => {
      const s = await create();
      const page = data<{
        items: {
          id: string;
          trackingCode: string;
          source: string;
          reference: string | null;
        }[];
      }>(
        await asAdmin(
          opsViewer,
          `/orders?merchantId=${merchantId}&limit=200`,
        ).expect(200),
      );
      expect(page.items.every((o) => o.source === 'merchant')).toBe(true);
      const byCode = data<{
        items: { id: string; reference: string | null }[];
      }>(
        await asAdmin(
          opsViewer,
          `/orders?trackingCode=${s.trackingCode.toLowerCase()}`,
        ).expect(200),
      );
      expect(byCode.items).toHaveLength(1);
      expect(byCode.items[0].reference).toBe(s.reference);
      const byReference = data<{ items: { id: string }[] }>(
        await asAdmin(
          opsViewer,
          `/orders?reference=${encodeURIComponent(s.reference)}`,
        ).expect(200),
      );
      expect(byReference.items.map((o) => o.id)).toEqual([byCode.items[0].id]);

      const detail = data<{
        receiver: { phone: string; email: string | null };
        shipment: { id: string } | null;
        events: { type: string }[];
      }>(await asAdmin(opsViewer, `/orders/${byCode.items[0].id}`).expect(200));
      expect(detail.receiver.phone).toMatch(/^\*+4567$/);
      expect(detail.receiver.email).toMatch(/^b\*+@/);
      expect(detail.shipment?.id).toBe(s.id);
      expect(detail.events.map((e) => e.type)).toContain('order_placed');
      await asAdmin(financeViewer, '/orders').expect(403);
    });

    it('summarises a period and exports CSVs through signed links (M6c)', async () => {
      const s = await create();
      const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const summary = data<{
        shipments: { created: number; byStatus: Record<string, number> };
        money: { shippingCharged: number };
        topDestinations: { nodeName: string }[];
      }>(await live.get(`/reports/summary?from=${from}&to=${to}`).expect(200));
      expect(summary.shipments.created).toBeGreaterThan(0);
      expect(summary.money.shippingCharged).toBeGreaterThan(0);
      expect(summary.topDestinations.length).toBeGreaterThan(0);
      const tooLong = new Date(Date.now() - 120 * 86_400_000).toISOString();
      expect(
        code(
          await live
            .get(`/reports/summary?from=${tooLong}&to=${to}`)
            .expect(422),
        ),
      ).toBe('REPORT_RANGE_INVALID');

      const link = data<{ downloadPath: string; expiresAt: string }>(
        await live.post('/exports/shipments', { from, to }).expect(200),
      );
      // No cookie or key: the signed link is the credential.
      const csv = await http().get(link.downloadPath).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      const lines = csv.text.trim().split('\r\n');
      expect(lines[0]).toMatch(/^created_at,reference,tracking_code,status/);
      expect(csv.text).toContain(s.trackingCode);
      const forged = link.downloadPath.replace(/.(?=$)/, (c) =>
        c === 'A' ? 'B' : 'A',
      );
      expect(code(await http().get(forged).expect(403))).toBe(
        'EXPORT_LINK_INVALID',
      );

      const wallet = data<{ downloadPath: string }>(
        await live.post('/exports/wallet-entries', { from, to }).expect(200),
      );
      expect(
        (await http().get(wallet.downloadPath).expect(200)).text,
      ).toContain('shipment_charge');

      const orders = data<{ downloadPath: string }>(
        await http()
          .post('/api/v1/admin/exports/orders')
          .set('Cookie', opsViewer)
          .send({ from, to, merchantId })
          .expect(200),
      );
      expect(
        (await http().get(orders.downloadPath).expect(200)).text,
      ).toContain(s.trackingCode);
      await http()
        .post('/api/v1/admin/exports/orders')
        .set('Cookie', financeViewer)
        .send({ from, to })
        .expect(403);
    });

    it('redacts receiver details 180 days after a parcel finishes (M6d)', async () => {
      jest
        .spyOn(app.get(CloudinaryService), 'deleteResource')
        .mockResolvedValue(undefined);
      const s = await create();
      await live.post(`/shipments/${s.id}/cancel`).expect(200);
      const { id: orderId } = await orderOf(s.trackingCode);
      await dataSource.query(
        `UPDATE orders SET "updatedAt" = now() - interval '200 days' WHERE id = $1`,
        [orderId],
      );
      const run = await app.get(PrivacyService).run();
      expect(run.ordersRedacted).toBeGreaterThanOrEqual(1);
      const [order] = await dataSource.query<
        {
          receiverFullName: string;
          receiverPhone: string;
          receiverEmail: string | null;
          piiRedactedAt: Date | null;
        }[]
      >(
        `SELECT "receiverFullName", "receiverPhone", "receiverEmail", "piiRedactedAt"
           FROM orders WHERE id = $1`,
        [orderId],
      );
      expect(order).toMatchObject({
        receiverFullName: '[redacted]',
        receiverPhone: '',
        receiverEmail: null,
      });
      expect(order.piiRedactedAt).not.toBeNull();
      const [shipmentRow] = await dataSource.query<
        { receiverName: string; receiverEmail: string | null }[]
      >(
        `SELECT "receiverName", "receiverEmail" FROM merchant_shipments WHERE id = $1`,
        [s.id],
      );
      expect(shipmentRow).toEqual({
        receiverName: '[redacted]',
        receiverEmail: null,
      });
    });

    it('answers data-subject export and erase requests (M6d)', async () => {
      const superAdmin = await signIn(
        await makeUser('privacy-super', {
          role: UserRole.ADMIN,
          adminPermissions: [AdminPermission.SUPER],
        }),
      );
      const email = `dsr+${randomUUID().slice(0, 6)}@${DOMAIN}`;
      const s = await create({
        receiver: { name: 'Ada Lovelace', phone: '08031230000', email },
      });
      const privacy = (path: string, body: object, cookie = superAdmin) =>
        http()
          .post(`/api/v1/admin/privacy/${path}`)
          .set('Cookie', cookie)
          .send(body);

      const exported = data<{
        orders: { trackingCode: string }[];
        shipments: unknown[];
      }>(
        await privacy('subject-export', { email: email.toUpperCase() }).expect(
          200,
        ),
      );
      expect(exported.orders.map((o) => o.trackingCode)).toEqual([
        s.trackingCode,
      ]);
      expect(exported.shipments).toHaveLength(1);
      await privacy('subject-export', { email }, opsViewer).expect(403);

      const early = data<{
        erasedOrders: number;
        skippedInFlight: { trackingCode: string }[];
      }>(
        await privacy('subject-erase', { email, reason: 'DSR-0001' }).expect(
          200,
        ),
      );
      expect(early.erasedOrders).toBe(0);
      expect(early.skippedInFlight.map((o) => o.trackingCode)).toEqual([
        s.trackingCode,
      ]);

      await live.post(`/shipments/${s.id}/cancel`).expect(200);
      const done = data<{ erasedOrders: number; skippedInFlight: unknown[] }>(
        await privacy('subject-erase', { email, reason: 'DSR-0001' }).expect(
          200,
        ),
      );
      expect(done).toMatchObject({ erasedOrders: 1, skippedInFlight: [] });
      const after = data<{ orders: unknown[]; shipments: unknown[] }>(
        await privacy('subject-export', { email }).expect(200),
      );
      expect(after).toEqual({ orders: [], shipments: [] });
    });

    it('shows the merchant 360', async () => {
      const view = data<{
        merchant: { id: string; tradingName: string };
        wallets: { live: { mode: string }; test: { mode: string } };
        shipments: { live: Record<string, number> };
        open: { claims: number };
        recentActivity: unknown[];
      }>(
        await asAdmin(opsViewer, `/merchants/${merchantId}/overview`).expect(
          200,
        ),
      );
      expect(view.merchant).toMatchObject({
        id: merchantId,
        tradingName: 'Live Stores',
      });
      expect(view.wallets.live.mode).toBe('live');
      expect(Object.keys(view.shipments.live).length).toBeGreaterThan(0);
      expect(typeof view.open.claims).toBe('number');
    });

    it('reports platform health and alerts ops once per breach', async () => {
      const health = data<{ checks: { key: string; ok: boolean }[] }>(
        await asAdmin(opsViewer, '/merchant-platform/health').expect(200),
      );
      expect(health.checks.map((c) => c.key)).toContain('outbox_failed_24h');

      const since = new Date();
      const [failed] = await dataSource.query<{ id: string }[]>(
        `INSERT INTO outbox_events ("eventType", payload, status, attempts, "lastError")
         VALUES ('email', '{}'::jsonb, 'failed', 5, 'test breach') RETURNING id`,
      );
      try {
        const service = app.get(PlatformHealthService);
        expect(await service.run()).toContain('outbox_failed_24h');
        expect((await latestEmailTo(`ops-views@${DOMAIN}`)).subject).toMatch(
          /Platform alert/,
        );
        // Still breached, but just alerted: no second email.
        expect(await service.run()).not.toContain('outbox_failed_24h');
        await dataSource.query(`DELETE FROM outbox_events WHERE id = $1`, [
          failed.id,
        ]);
        await service.run();
        // Closed once nothing else in the test DB keeps it breached.
        const [others] = await dataSource.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM outbox_events
            WHERE status = 'failed' AND "updatedAt" > now() - interval '24 hours'`,
        );
        const [open] = await dataSource.query<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM ops_alerts
            WHERE key = 'outbox_failed_24h' AND "resolvedAt" IS NULL`,
        );
        expect(open.count).toBe(others.count > 0 ? 1 : 0);
      } finally {
        await dataSource.query(`DELETE FROM outbox_events WHERE id = $1`, [
          failed.id,
        ]);
        await dataSource.query(
          `DELETE FROM ops_alerts WHERE "openedAt" >= $1`,
          [since],
        );
      }
    });
  });

  describe('go-live checklist and pick links (M7)', () => {
    interface Checklist {
      ready: boolean;
      items: {
        key: string;
        kind: string;
        required: boolean;
        done: boolean | null;
      }[];
    }
    interface Link {
      id: string;
      reference: string;
      status: string;
      url: string;
      hidePrices: boolean;
      shipmentId: string | null;
    }
    const pub = {
      get: (path: string) => http().get(`/api/v1/pick/${path}`),
      post: (token: string, body: object) =>
        http()
          .post(`/api/v1/pick/${token}`)
          .set('X-Locoomo-Client', 'web')
          .send(body),
    };
    const tokenOf = (link: Link): string => link.url.split('/pick/')[1];
    const draft = (reference: string) => ({
      reference,
      origin: { type: 'node', nodeId: node.origin },
      receiver: {
        name: 'Ngozi Adeyemi',
        phone: '08035550123',
        email: `pick+${randomUUID().slice(0, 6)}@${DOMAIN}`,
      },
      parcel: { description: 'Sandals', size: 'small', weightKg: 0.6 },
    });
    const newLink = async (reference: string, extra: object = {}) =>
      data<Link>(
        await live
          .post('/pick-links', { shipment: draft(reference), ...extra })
          .expect(201),
      );

    it('lists what stands between the merchant and live', async () => {
      const list = data<Checklist>(
        await live.get('/go-live-checklist').expect(200),
      );
      const item = (key: string) => list.items.find((i) => i.key === key);
      expect(item('approved')?.done).toBe(true);
      expect(item('wallet_funded')?.done).toBe(true);
      // The owner has no 2FA factor and there is no live secret key.
      expect(item('two_factor')?.done).toBe(false);
      expect(item('live_secret_key')?.done).toBe(false);
      expect(item('webhook_dedupe')).toMatchObject({
        kind: 'manual',
        done: null,
      });
      expect(list.ready).toBe(false);
    });

    it('lets the buyer pick their Node, then creates the shipment', async () => {
      const reference = `P-${randomUUID().slice(0, 8)}`;
      const link = await newLink(reference);
      expect(link).toMatchObject({
        reference,
        status: 'open',
        shipmentId: null,
      });
      expect(link.url).toMatch(/\/pick\/[A-Za-z0-9_-]{32}$/);
      const token = tokenOf(link);

      // The same reference can't be reused while the link is open.
      const dup = await live
        .post('/pick-links', { shipment: draft(reference) })
        .expect(409);
      expect(code(dup)).toBe('DUPLICATE_REFERENCE');

      const page = data<Record<string, unknown>>(
        await pub.get(token).expect(200),
      );
      expect(page).toMatchObject({
        status: 'open',
        merchantName: 'Live Stores',
        receiverFirstName: 'Ngozi',
        parcel: { description: 'Sandals', size: 'small' },
        picked: null,
      });
      // Only the first name: no phone, email or surname.
      expect(JSON.stringify(page)).not.toMatch(/0803|Adeyemi|@/);

      const nodes = data<{ id: string; priceKobo: number | null }[]>(
        await pub.get(`${token}/nodes?near=7.5,3.95`).expect(200),
      );
      const choice = nodes.find((n) => n.id === node.destination);
      expect(choice?.priceKobo).toBeGreaterThan(0);

      const before = await wallet();
      const picked = data<{ trackingCode: string; nodeName: string }>(
        await pub
          .post(token, { destinationNodeId: node.destination })
          .expect(200),
      );
      expect(picked.nodeName).toBe(`${NODE_PREFIX}Destination`);
      const after = await wallet();
      expect(after.heldKobo).toBeGreaterThan(before.heldKobo);

      const used = data<Link>(
        await live.get(`/pick-links/${link.id}`).expect(200),
      );
      expect(used.status).toBe('used');
      const s = await shipment(used.shipmentId!);
      expect(s).toMatchObject({ reference, trackingCode: picked.trackingCode });

      // One use only; the page now shows where it's going.
      expect(
        code(
          await pub
            .post(token, { destinationNodeId: node.destination })
            .expect(410),
        ),
      ).toBe('PICK_LINK_UNAVAILABLE');
      expect(
        data<{ status: string; picked: unknown }>(
          await pub.get(token).expect(200),
        ),
      ).toMatchObject({
        status: 'used',
        picked: { trackingCode: picked.trackingCode },
      });
      await live.post(`/shipments/${s.id}/cancel`).expect(200);
    });

    it('validates the draft like a shipment and hides prices on request', async () => {
      const bad = await live
        .post('/pick-links', {
          shipment: { ...draft(`P-${randomUUID().slice(0, 8)}`), receiver: {} },
        })
        .expect(400);
      expect(JSON.stringify(bad.body)).toMatch(/shipment\.receiver\./);

      const link = await newLink(`P-${randomUUID().slice(0, 8)}`, {
        hidePrices: true,
      });
      const nodes = data<{ id: string; priceKobo: number | null }[]>(
        await pub.get(`${tokenOf(link)}/nodes?near=7.5,3.95`).expect(200),
      );
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every((n) => n.priceKobo === null)).toBe(true);
    });

    it('retires a link whose reference the merchant used on a shipment', async () => {
      const reference = `P-${randomUUID().slice(0, 8)}`;
      const link = await newLink(reference);
      // POST /shipments doesn't know about pick links: the merchant can
      // take the reference themselves.
      const own = await create({ reference });
      const refused = await pub
        .post(tokenOf(link), { destinationNodeId: node.destination })
        .expect(410);
      expect(code(refused)).toBe('PICK_LINK_UNAVAILABLE');
      expect(
        data<Link>(await live.get(`/pick-links/${link.id}`).expect(200)).status,
      ).toBe('cancelled');
      await live.post(`/shipments/${own.id}/cancel`).expect(200);
    });

    it('reopens the link when the pick fails, and honours cancel and expiry', async () => {
      const link = await newLink(`P-${randomUUID().slice(0, 8)}`);
      const token = tokenOf(link);
      // A Node that can't take it: refused, and the link stays usable.
      const failed = await pub
        .post(token, { destinationNodeId: randomUUID() })
        .expect(422);
      expect(code(failed)).toBe('PICK_LINK_FAILED');
      expect(
        data<Link>(await live.get(`/pick-links/${link.id}`).expect(200)).status,
      ).toBe('open');

      const cancelled = data<Link>(
        await live.post(`/pick-links/${link.id}/cancel`).expect(200),
      );
      expect(cancelled.status).toBe('cancelled');
      expect(
        code(
          await pub
            .post(token, { destinationNodeId: node.destination })
            .expect(410),
        ),
      ).toBe('PICK_LINK_UNAVAILABLE');
      expect(
        code(await live.post(`/pick-links/${link.id}/cancel`).expect(410)),
      ).toBe('PICK_LINK_UNAVAILABLE');

      const old = await newLink(`P-${randomUUID().slice(0, 8)}`);
      await dataSource.query(
        `UPDATE pick_links SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`,
        [old.id],
      );
      expect(
        data<{ status: string }>(await pub.get(tokenOf(old)).expect(200))
          .status,
      ).toBe('expired');
      await pub.get(`${tokenOf(old)}/nodes`).expect(410);
      // An expired link frees its reference.
      await newLink(old.reference);

      await pub.get('A'.repeat(32)).expect(404);
      const listed = data<{ items: Link[] }>(
        await live.get('/pick-links?limit=50').expect(200),
      );
      expect(listed.items.map((l) => l.id)).toEqual(
        expect.arrayContaining([link.id, old.id]),
      );
    });
  });

  describe('closing an account with live money and parcels', () => {
    it('refuses while parcels are in flight', async () => {
      const s = await create();
      const refused = await http()
        .post('/api/v1/merchant/account/close')
        .set('Cookie', owner)
        .set('X-Locoomo-Client', 'web')
        .expect(409);
      expect(code(refused)).toBe('MERCHANT_CLOSE_BLOCKED');
      expect(
        (refused.body as { error: { details: { inFlightShipments: number } } })
          .error.details.inFlightShipments,
      ).toBeGreaterThan(0);
      await live.post(`/shipments/${s.id}/cancel`).expect(200);
    });

    it('closes with a positive balance and tells finance to refund it', async () => {
      const closer = await signIn(await makeUser('closer'));
      const id = data<{ merchant: { id: string } }>(
        await http()
          .post('/api/v1/merchant/account')
          .set('Cookie', closer)
          .send({ type: 'business', tradingName: 'Closing Stores' })
          .expect(201),
      ).merchant.id;
      try {
        await dataSource.query(
          `UPDATE merchants SET status = 'approved', tier = 'business' WHERE id = $1`,
          [id],
        );
        await dataSource.transaction((manager) =>
          app.get(WalletService).creditExternal(manager, {
            merchantId: id,
            mode: 'live',
            type: WalletEntryType.TOP_UP,
            amountKobo: 250_000,
            description: 'Test funding',
            externalRef: `test:${id}`,
          }),
        );
        await http()
          .post('/api/v1/merchant/account/close')
          .set('Cookie', closer)
          .set('X-Locoomo-Client', 'web')
          .expect(204);
        const email = await latestEmailTo(`admin@${DOMAIN}`);
        expect(email.subject).toBe(
          'Refund due: Closing Stores closed their account',
        );
        expect(email.text).toContain('2,500');
      } finally {
        await dataSource.query(
          `DELETE FROM audit_events WHERE "merchantId" = $1`,
          [id],
        );
        await dataSource.query(`DELETE FROM merchants WHERE id = $1`, [id]);
      }
    });
  });

  it('leaves the wallet ledger balanced', async () => {
    const drift = await app.get(WalletReconciliationService).run();
    expect(drift.filter((d) => d.merchantId === merchantId)).toEqual([]);
  });
});
