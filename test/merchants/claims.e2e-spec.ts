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
import { CloudinaryService } from '../../src/common/cloudinary/cloudinary.service';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { ApiRateLimiter } from '../../src/modules/merchants/application/api-rate-limiter';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'claims.e2e.test';
const NODE_PREFIX = 'MCLM-';
const CENTRE = { latitude: 7.45, longitude: 3.9 };

interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}
interface Claim {
  id: string;
  shipmentId: string;
  reference: string;
  type: string;
  source: string;
  status: string;
  evidence: string[];
  declaredValueKobo: number | null;
  maxPayoutKobo: number;
  payoutKobo: number | null;
  decisionNote: string | null;
}
interface Shipment {
  id: string;
  trackingCode: string;
  status: string;
  exception: { type: string; claimId: string | null } | null;
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant claims, sandbox (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let ownerCookies: string[];
  let ops: string[];
  let merchantId: string;
  let key: string;
  let readOnlyKey: string;
  const node = { origin: '', home: '' };
  const uploaded = new Set<string>();

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
  });

  const create = async (declaredValueKobo: number | null = 2_000_000) =>
    data<Shipment>(
      await api(key)
        .post('/shipments', {
          reference: `C-${randomUUID().slice(0, 8)}`,
          destinationNodeId: node.home,
          origin: { type: 'node', nodeId: node.origin },
          receiver: {
            name: 'Chioma Okafor',
            phone: '08031234567',
            email: 'c@example.com',
          },
          parcel: {
            description: 'Earbuds',
            size: 'small',
            weightKg: 0.4,
            ...(declaredValueKobo === null ? {} : { declaredValueKobo }),
          },
        })
        .expect(201),
    );
  const simulate = (id: string, to: string, body: object = {}) =>
    api(key)
      .post(`/test/shipments/${id}/simulate`, { to, ...body })
      .expect(200);
  const balance = async (): Promise<number> =>
    data<{ balanceKobo: number }>(await api(key).get('/wallet').expect(200))
      .balanceKobo;

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
      .overrideProvider(CloudinaryService)
      .useValue({
        generateUploadSignature: (folder: string) => ({
          signature: 'sig',
          timestamp: 1,
          apiKey: 'key',
          cloudName: 'cloud',
          folder,
          type: 'authenticated',
        }),
        resourceExists: (publicId: string) =>
          Promise.resolve(uploaded.has(publicId)),
        getExpiringDownloadUrl: (publicId: string) => ({
          url: `https://files.example/${publicId}`,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    users = moduleFixture.get(getRepositoryToken(UserEntity));
    dataSource = moduleFixture.get(DataSource);

    const superAdmin = await signIn(
      await makeUser('super', {
        role: UserRole.ADMIN,
        adminPermissions: [AdminPermission.SUPER],
      }),
    );
    await http()
      .post('/api/v1/admin/pricing')
      .set('Cookie', superAdmin)
      .send({ baseFeeNaira: 500, perKmRateNaira: 100, destinationFeeNaira: 50 })
      .expect(201);
    node.origin = await createNode(superAdmin, 'Origin', 0);
    node.home = await createNode(superAdmin, 'Home', 2);
    ops = await signIn(
      await makeUser('ops', {
        role: UserRole.ADMIN,
        adminPermissions: [AdminPermission.OPS],
      }),
    );

    ownerCookies = await signIn(await makeUser('owner'));
    merchantId = data<{ merchant: { id: string } }>(
      await http()
        .post('/api/v1/merchant/account')
        .set('Cookie', ownerCookies)
        .send({ type: 'business', tradingName: 'Claim Stores' })
        .expect(201),
    ).merchant.id;
    key = await newKey({});
    readOnlyKey = await newKey({ scopes: ['shipments:read'] });
    uploaded.add(`merchants/${merchantId}/claims/photo-1`);
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

  it('files a damaged claim with evidence, capped at the declared value', async () => {
    const s = await create(2_000_000);
    await simulate(s.id, 'collected');

    const signature = data<{ folder: string }>(
      await api(key).post('/claims/uploads').expect(200),
    );
    expect(signature.folder).toBe(`merchants/${merchantId}/claims`);

    const claim = data<Claim>(
      await api(key)
        .post('/claims', {
          shipmentId: s.id,
          type: 'damaged',
          description: 'Screen cracked on arrival, box crushed.',
          evidence: [`merchants/${merchantId}/claims/photo-1`],
        })
        .expect(201),
    );
    expect(claim).toMatchObject({
      shipmentId: s.id,
      type: 'damaged',
      source: 'merchant',
      status: 'open',
      evidence: [`merchants/${merchantId}/claims/photo-1`],
      declaredValueKobo: 2_000_000,
      maxPayoutKobo: 2_000_000,
      payoutKobo: null,
    });

    const again = await api(key)
      .post('/claims', {
        shipmentId: s.id,
        type: 'missing_item',
        description: 'One earbud missing from the box.',
      })
      .expect(409);
    expect(code(again)).toBe('CLAIM_ALREADY_OPEN');
    expect((again.body as ErrorBody).error.details).toEqual({
      claimId: claim.id,
    });

    const list = data<{ items: Claim[] }>(
      await api(readOnlyKey).get(`/claims?shipmentId=${s.id}`).expect(200),
    );
    expect(list.items.map((c) => c.id)).toEqual([claim.id]);
  });

  it('refuses claims that make no sense, too late, or with foreign uploads', async () => {
    const created = await create();
    expect(
      code(
        await api(key)
          .post('/claims', {
            shipmentId: created.id,
            type: 'damaged',
            description: 'Never even dropped off.',
          })
          .expect(409),
      ),
    ).toBe('CLAIM_NOT_ALLOWED');

    const collected = await create();
    await simulate(collected.id, 'collected');
    expect(
      code(
        await api(key)
          .post('/claims', {
            shipmentId: collected.id,
            type: 'lost',
            description: 'The buyer collected it, so not lost.',
          })
          .expect(409),
      ),
    ).toBe('CLAIM_NOT_ALLOWED');
    expect(
      code(
        await api(key)
          .post('/claims', {
            shipmentId: collected.id,
            type: 'damaged',
            description: 'Somebody else’s upload id here.',
            evidence: ['merchants/someone-else/claims/photo-1'],
          })
          .expect(422),
      ),
    ).toBe('UPLOAD_NOT_FOUND');

    await dataSource.query(
      `UPDATE merchant_shipments SET "statusChangedAt" = now() - interval '31 days' WHERE id = $1`,
      [collected.id],
    );
    expect(
      code(
        await api(key)
          .post('/claims', {
            shipmentId: collected.id,
            type: 'damaged',
            description: 'Filed a month too late.',
          })
          .expect(422),
      ),
    ).toBe('CLAIM_WINDOW_CLOSED');

    expect(
      code(
        await api(readOnlyKey)
          .post('/claims', {
            shipmentId: collected.id,
            type: 'damaged',
            description: 'Key without claims:write.',
          })
          .expect(403),
      ),
    ).toBe('INSUFFICIENT_SCOPE');
  });

  it('opens a claim when a parcel becomes an exception', async () => {
    const s = await create(null);
    await simulate(s.id, 'exception', { exceptionType: 'damaged' });
    const after = data<Shipment>(
      await api(key).get(`/shipments/${s.id}`).expect(200),
    );
    expect(after.exception?.claimId).toEqual(expect.any(String));
    const claim = data<Claim>(
      await api(key).get(`/claims/${after.exception!.claimId}`).expect(200),
    );
    expect(claim).toMatchObject({
      source: 'exception',
      type: 'damaged',
      status: 'open',
      declaredValueKobo: null,
      maxPayoutKobo: 5_000_000,
    });
  });

  it('lets the merchant decide test claims: approve credits the test wallet', async () => {
    const s = await create(1_500_000);
    await simulate(s.id, 'collected');
    const claim = data<Claim>(
      await api(key)
        .post('/claims', {
          shipmentId: s.id,
          type: 'missing_item',
          description: 'Charging case missing.',
        })
        .expect(201),
    );
    const before = await balance();
    expect(
      code(
        await api(key)
          .post(`/test/claims/${claim.id}/decide`, {
            decision: 'approve',
            amountKobo: 1_500_001,
          })
          .expect(422),
      ),
    ).toBe('CLAIM_PAYOUT_TOO_HIGH');
    const approved = data<Claim>(
      await api(key)
        .post(`/test/claims/${claim.id}/decide`, {
          decision: 'approve',
          note: 'Sorry about that.',
        })
        .expect(200),
    );
    expect(approved).toMatchObject({
      status: 'approved',
      payoutKobo: 1_500_000,
      decisionNote: 'Sorry about that.',
    });
    expect(await balance()).toBe(before + 1_500_000);
    const entries = data<{ items: { type: string; shipmentId: string }[] }>(
      await api(key).get('/wallet/entries?type=claim_credit').expect(200),
    );
    expect(entries.items[0]).toMatchObject({
      type: 'claim_credit',
      shipmentId: s.id,
    });
    const [event] = await dataSource.query<{ body: string }[]>(
      `SELECT body FROM webhook_events WHERE "merchantId" = $1 AND type = 'claim.decided'
        ORDER BY "createdAt" DESC LIMIT 1`,
      [merchantId],
    );
    expect(
      (JSON.parse(event.body) as { data: { claim: Claim } }).data.claim,
    ).toMatchObject({ id: claim.id, status: 'approved' });

    expect(
      code(
        await api(key)
          .post(`/test/claims/${claim.id}/decide`, { decision: 'reject' })
          .expect(409),
      ),
    ).toBe('CLAIM_ALREADY_DECIDED');
  });

  it('allows a new claim after a rejection, and keeps admins off test claims', async () => {
    const s = await create();
    await simulate(s.id, 'collected');
    const first = data<Claim>(
      await api(key)
        .post('/claims', {
          shipmentId: s.id,
          type: 'damaged',
          description: 'Dented casing on arrival.',
        })
        .expect(201),
    );
    expect(
      code(
        await http()
          .post(`/api/v1/admin/merchant-claims/${first.id}/reject`)
          .set('Cookie', ops)
          .send({ merchantNote: 'No.' + ' Test claim.' })
          .expect(403),
      ),
    ).toBe('LIVE_MODE_ONLY');
    await api(key)
      .post(`/test/claims/${first.id}/decide`, { decision: 'reject' })
      .expect(200);
    await api(key)
      .post('/claims', {
        shipmentId: s.id,
        type: 'damaged',
        description: 'Here are better photos this time.',
      })
      .expect(201);
  });
});
