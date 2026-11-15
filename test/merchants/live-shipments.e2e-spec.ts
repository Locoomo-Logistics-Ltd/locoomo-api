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

  it('leaves the wallet ledger balanced', async () => {
    const drift = await app.get(WalletReconciliationService).run();
    expect(drift.filter((d) => d.merchantId === merchantId)).toEqual([]);
  });
});
