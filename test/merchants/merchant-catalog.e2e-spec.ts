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
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'catalog.e2e.test';
const NODE_PREFIX = 'MCAT-';
// Away from other suites' Nodes (Abuja), so "near" results are ours.
const CENTRE = { latitude: 9.07, longitude: 7.4 };

interface ErrorBody {
  error: { code: string };
}
interface NodeView {
  id: string;
  name: string;
  distanceKm: number | null;
  acceptingParcels: boolean;
  openingHours: Record<string, { open: string; close: string }[]>;
}
interface NodeList {
  items: NodeView[];
  nextCursor: string | null;
  hasMore: boolean;
}
interface Quote {
  currency: string;
  amountKobo: number | null;
  breakdown: {
    baseKobo: number;
    distanceKobo: number;
    volumeDiscountKobo: number;
    vatKobo: number;
  } | null;
  vehicleClass: string;
  estimatedReadyInWorkingDays: number;
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant Nodes and quotes (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let ownerCookies: string[];
  let secretKey: string;
  let publishableKey: string;
  let hiddenPricesKey: string;
  const node: Record<'near' | 'far' | 'full' | 'private' | 'origin', string> = {
    near: '',
    far: '',
    full: '',
    private: '',
    origin: '',
  };

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const code = (response: request.Response): string =>
    (response.body as ErrorBody).error.code;
  const data = <T>(response: request.Response): T =>
    (response.body as { data: T }).data;
  const withKey = (key: string, url: string) =>
    http().get(`/api/v1/merchant${url}`).set('Authorization', `Bearer ${key}`);

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

  async function createNode(
    adminCookies: string[],
    name: string,
    offsetKm: number,
  ): Promise<string> {
    const response = await http()
      .post('/api/v1/nodes')
      .set('Cookie', adminCookies)
      .send({
        name: `${NODE_PREFIX}${name}`,
        address: `${name} street`,
        city: 'Abuja',
        state: 'FCT',
        latitude: CENTRE.latitude + offsetKm / 111,
        longitude: CENTRE.longitude,
        capacity: 10,
        ...NODE_CONTACT_FIELDS,
      })
      .expect(201);
    return data<{ id: string }>(response).id;
  }

  async function createKey(body: object): Promise<string> {
    return data<{ secret: string }>(
      await http()
        .post('/api/v1/merchant/api-keys')
        .set('Cookie', ownerCookies)
        .set('X-Locoomo-Client', 'web')
        .send({ mode: 'test', ...body })
        .expect(201),
    ).secret;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    node.near = await createNode(admin, 'Near', 1);
    node.far = await createNode(admin, 'Far', 3);
    node.full = await createNode(admin, 'Full', 2);
    node.private = await createNode(admin, 'Private', 2.5);
    node.origin = await createNode(admin, 'Origin', 0.5);
    await dataSource.query(
      `UPDATE nodes SET "currentCount" = capacity WHERE id = $1`,
      [node.full],
    );
    await dataSource.query(
      `UPDATE nodes SET "isPubliclyVisible" = false WHERE id = $1`,
      [node.private],
    );

    ownerCookies = await signIn(await makeUser('owner'));
    await http()
      .post('/api/v1/merchant/account')
      .set('Cookie', ownerCookies)
      .send({ type: 'business', tradingName: 'Catalog' })
      .expect(201);
    secretKey = await createKey({ kind: 'secret', name: 'Server' });
    publishableKey = await createKey({ kind: 'publishable', name: 'Checkout' });
    hiddenPricesKey = await createKey({
      kind: 'publishable',
      name: 'Hidden',
      hidePrices: true,
    });
  });

  afterAll(async () => {
    try {
      const pattern = `%@${DOMAIN}`;
      await dataSource.query(
        `DELETE FROM merchant_api_requests WHERE "merchantId" IN (SELECT m.id FROM merchants m JOIN users u ON u.id = m."createdByUserId" WHERE u.email LIKE $1)`,
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

  const near = `near=${CENTRE.latitude},${CENTRE.longitude}&radiusKm=5&q=${NODE_PREFIX}`;

  it('lists open Nodes with space, nearest first, and pages with a cursor', async () => {
    const list = data<NodeList>(
      await withKey(secretKey, `/nodes?${near}`).expect(200),
    );
    expect(list.items.map((n) => n.name)).toEqual([
      `${NODE_PREFIX}Origin`,
      `${NODE_PREFIX}Near`,
      `${NODE_PREFIX}Far`,
    ]);
    expect(list.items[1].distanceKm).toBeCloseTo(1, 0);
    expect(list.items[1].openingHours.mon).toEqual([
      { open: '08:00', close: '18:00' },
    ]);
    expect(list.hasMore).toBe(false);

    const first = data<NodeList>(
      await withKey(secretKey, `/nodes?${near}&limit=2`).expect(200),
    );
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = data<NodeList>(
      await withKey(
        secretKey,
        `/nodes?${near}&limit=2&cursor=${first.nextCursor}`,
      ).expect(200),
    );
    expect(second.items.map((n) => n.name)).toEqual([`${NODE_PREFIX}Far`]);
    expect(second.nextCursor).toBeNull();

    expect(
      code(await withKey(secretKey, `/nodes?cursor=bogus`).expect(400)),
    ).toBe('INVALID_CURSOR');
    expect(code(await withKey(secretKey, `/nodes?near=91,3`).expect(400))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('filters by text and city without a location, sorted by name', async () => {
    const list = data<NodeList>(
      await withKey(secretKey, `/nodes?q=${NODE_PREFIX}&city=abuja`).expect(
        200,
      ),
    );
    expect(list.items.map((n) => n.name)).toEqual([
      `${NODE_PREFIX}Far`,
      `${NODE_PREFIX}Near`,
      `${NODE_PREFIX}Origin`,
    ]);
    expect(list.items[0].distanceKm).toBeNull();
  });

  it('returns one Node, says when it is full, and hides withdrawn ones', async () => {
    const one = data<NodeView>(
      await withKey(secretKey, `/nodes/${node.near}`).expect(200),
    );
    expect(one).toMatchObject({ id: node.near, acceptingParcels: true });
    const full = data<NodeView>(
      await withKey(secretKey, `/nodes/${node.full}`).expect(200),
    );
    expect(full.acceptingParcels).toBe(false);
    expect(
      code(await withKey(secretKey, `/nodes/${node.private}`).expect(404)),
    ).toBe('NOT_FOUND');
  });

  it('quotes a parcel with a breakdown that adds up', async () => {
    const missingOrigin = await withKey(
      secretKey,
      `/quotes?destinationNodeId=${node.far}&parcelSize=small`,
    ).expect(422);
    expect(code(missingOrigin)).toBe('ORIGIN_REQUIRED');

    const quote = data<Quote>(
      await withKey(
        secretKey,
        `/quotes?originNodeId=${node.origin}&destinationNodeId=${node.far}&parcelSize=small&weightKg=0.4`,
      ).expect(200),
    );
    expect(quote.currency).toBe('NGN');
    expect(quote.amountKobo).toBeGreaterThan(0);
    const b = quote.breakdown!;
    expect(b.baseKobo + b.distanceKobo + b.volumeDiscountKobo).toBe(
      quote.amountKobo,
    );
    expect(b.vatKobo).toBe(0);
    expect(quote.vehicleClass).toBeTruthy();
    expect(quote.estimatedReadyInWorkingDays).toBeGreaterThanOrEqual(2);

    expect(
      code(
        await withKey(
          secretKey,
          `/quotes?originNodeId=${node.origin}&destinationNodeId=${node.private}&parcelSize=small`,
        ).expect(404),
      ),
    ).toBe('NOT_FOUND');
  });

  it('serves checkouts with publishable keys, from any origin, hiding prices when asked', async () => {
    const quoteUrl = `/quotes?originNodeId=${node.origin}&destinationNodeId=${node.near}&parcelSize=small`;
    const fromBrowser = await withKey(publishableKey, quoteUrl)
      .set('Origin', 'https://shop.example.com')
      .expect(200);
    expect(fromBrowser.headers['access-control-allow-origin']).toBe(
      'https://shop.example.com',
    );
    expect(data<Quote>(fromBrowser).amountKobo).toBeGreaterThan(0);

    const hidden = data<Quote>(
      await withKey(hiddenPricesKey, quoteUrl).expect(200),
    );
    expect(hidden).toMatchObject({ amountKobo: null, breakdown: null });
    expect(hidden.vehicleClass).toBeTruthy();

    await withKey(publishableKey, `/nodes?${near}`).expect(200);
  });

  it('works from the dashboard for team members only', async () => {
    const list = data<NodeList>(
      await http()
        .get(`/api/v1/merchant/nodes?${near}`)
        .set('Cookie', ownerCookies)
        .expect(200),
    );
    expect(list.items).toHaveLength(3);

    const outsider = await signIn(await makeUser('outsider'));
    const refused = await http()
      .get(`/api/v1/merchant/nodes?${near}`)
      .set('Cookie', outsider)
      .expect(403);
    expect(code(refused)).toBe('NOT_A_MERCHANT_MEMBER');
  });
});
