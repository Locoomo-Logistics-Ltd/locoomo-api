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
import { ShipmentExpiryService } from '../../src/modules/merchants/application/shipment-expiry.service';
import { WalletReconciliationService } from '../../src/modules/merchants/application/wallet-reconciliation.service';
import { WalletService } from '../../src/modules/merchants/application/wallet.service';
import { WalletEntryType } from '../../src/modules/merchants/domain/wallet';
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
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
  exception: { type: string } | null;
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
  let merchantId: string;
  const node = { origin: '', destination: '' };
  const previousFlag = process.env.MERCHANT_LIVE_SHIPMENTS_ENABLED;

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
  const handoff = (cookie: string[], orderId: string, step: string, body = {}) =>
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
  const step = (fn: (orderId: string, manager: never) => Promise<unknown>) =>
    async (orderId: string) =>
      dataSource.transaction((manager) => fn(orderId, manager as never));
  const pickUp = step(async (id, m) => {
    await orders.markCourierAssigned(id, 'test-courier', m);
    await orders.markPickedUpByRider(id, m);
  });
  const arrive = step((id, m) => orders.markArrivedAtDestination(id, m));

  async function latestEmailTo(to: string): Promise<{ subject: string; text: string }> {
    const [row] = await dataSource.query<{ payload: { subject: string; text: string } }[]>(
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
  async function onShelf(): Promise<{ s: Shipment; orderId: string; email: string }> {
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
    process.env.MERCHANT_LIVE_SHIPMENTS_ENABLED = 'true';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
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
    if (previousFlag === undefined) {
      delete process.env.MERCHANT_LIVE_SHIPMENTS_ENABLED;
    } else {
      process.env.MERCHANT_LIVE_SHIPMENTS_ENABLED = previousFlag;
    }
    try {
      const pattern = `%@${DOMAIN}`;
      const ours = `SELECT id FROM orders WHERE "merchantId" = $1`;
      await dataSource.query(
        `DELETE FROM revenue_split_entries WHERE "orderId" IN (${ours})`,
        [merchantId],
      );
      await dataSource.query(`DELETE FROM delivery_legs WHERE "orderId" IN (${ours})`, [
        merchantId,
      ]);
      await dataSource.query(`DELETE FROM handoff_codes WHERE "orderId" IN (${ours})`, [
        merchantId,
      ]);
      await dataSource.query(`DELETE FROM order_events WHERE "orderId" IN (${ours})`, [
        merchantId,
      ]);
      await dataSource.query(
        `DELETE FROM audit_events WHERE "merchantId" = $1 OR "actorId" IN (SELECT id FROM users WHERE email LIKE $2)`,
        [merchantId, pattern],
      );
      await dataSource.query(`DELETE FROM merchants WHERE id = $1`, [merchantId]);
      await dataSource.query(`DELETE FROM orders WHERE "merchantId" = $1`, [merchantId]);
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
      await dataSource.query(`DELETE FROM users WHERE email LIKE $1`, [pattern]);
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
    expect(await wallet()).toMatchObject(before);
  });

  it('refuses at the counter without touching the origin slot', async () => {
    const before = await wallet();
    const slots = await originCount();
    const s = await create();
    const orderId = (await orderOf(s.trackingCode)).id;
    await handoff(originOperator, orderId, 'refuse', { reason: 'packaging' }).expect(200);
    expect(await shipment(s.id)).toMatchObject({
      status: 'refused',
      fee: { state: 'released' },
    });
    expect(await wallet()).toMatchObject(before);
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
    await handoff(destinationOperator, orderId, 'intake').expect(200);
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
    expect(await app.get(ShipmentExpiryService).run()).toBeGreaterThanOrEqual(1);
    expect((await shipment(s.id)).status).toBe('expired');
    expect((await orderOf(s.trackingCode)).status).toBe('cancelled');
    expect(await wallet()).toMatchObject(before);
  });

  it('enforces the live rules: relay, daily limit, paused creation', async () => {
    const relay = await live
      .post('/shipments', {
        reference: `L-${randomUUID().slice(0, 8)}`,
        destinationNodeId: node.destination,
        origin: { type: 'node', nodeId: node.origin },
        receiver: { name: 'A', phone: '08031234567', email: `a@${DOMAIN}` },
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
            receiver: { name: 'A', phone: '08031234567', email: `a@${DOMAIN}` },
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
            receiver: { name: 'A', phone: '08031234567', email: `a@${DOMAIN}` },
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

  it('leaves the wallet ledger balanced', async () => {
    const drift = await app.get(WalletReconciliationService).run();
    expect(drift.filter((d) => d.merchantId === merchantId)).toEqual([]);
  });
});
