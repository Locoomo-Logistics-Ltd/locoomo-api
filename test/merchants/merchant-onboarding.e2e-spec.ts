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
import { CloudinaryService } from '../../src/common/cloudinary/cloudinary.service';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { CURRENT_MERCHANT_TERMS_VERSION } from '../../src/modules/merchants/domain/merchant-terms';
import { PaystackBankService } from '../../src/modules/payments/application/paystack-bank.service';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'merchants.e2e.test';

interface Envelope<T> {
  data: T;
}
interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}

interface Overview {
  merchant: {
    id: string;
    status: string;
    tier: string | null;
    limits: { liveShipmentsPerDay: number | null } | null;
    decisionNote: string | null;
  };
  me: { memberId: string; role: string; permissions: string[] };
  onboarding: {
    readyToSubmit: boolean;
    editable: boolean;
    items: {
      key: string;
      complete: boolean;
      missing: string[];
      review: { decision: string; reason: string | null } | null;
    }[];
  };
  bankAccount: { accountName: string; accountNumberLast4: string } | null;
  directors: { id: string; idNumberLast4: string }[];
}

class FakeCloudinary {
  uploaded = new Set<string>();
  generateUploadSignature(folder: string) {
    return {
      signature: 'sig',
      timestamp: 1,
      apiKey: 'key',
      cloudName: 'cloud',
      folder,
    };
  }
  resourceExists(publicId: string): Promise<boolean> {
    return Promise.resolve(this.uploaded.has(publicId));
  }
  getExpiringDownloadUrl(publicId: string, ttlSeconds: number) {
    return {
      url: `https://files.test/${publicId}?ttl=${ttlSeconds}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }
  getSignedViewUrl(publicId: string): string {
    return `https://files.test/${publicId}`;
  }
}

class FakeBanks {
  accountName = 'ADA STORES LIMITED';
  listBanks() {
    return Promise.resolve([{ code: '058', name: 'GTBank' }]);
  }
  resolveAccountNumber() {
    return Promise.resolve({ accountName: this.accountName });
  }
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant accounts, onboarding and review (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let jwt: JwtService;
  const cloudinary = new FakeCloudinary();
  const banks = new FakeBanks();

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

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

  async function makeAdmin(
    name: string,
    permissions: AdminPermission[],
  ): Promise<UserEntity> {
    return makeUser(name, {
      role: UserRole.ADMIN,
      adminPermissions: permissions,
    });
  }

  // A fresh sign-in counts as a recent step-up (password just checked).
  async function signIn(user: UserEntity): Promise<string[]> {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    return cookiesFrom(login);
  }

  // A session that signed in long enough ago that step-up is needed again.
  const staleSession = (user: UserEntity): string[] => [
    `access_token=${jwt.sign({ sub: user.id, role: user.role })}`,
  ];

  const as = (cookies: string[]) => ({
    get: (url: string) => http().get(`/api/v1${url}`).set('Cookie', cookies),
    post: (url: string, body: object = {}) =>
      http()
        .post(`/api/v1${url}`)
        .set('Cookie', cookies)
        .set('X-Locoomo-Client', 'web')
        .send(body),
    put: (url: string, body: object = {}) =>
      http()
        .put(`/api/v1${url}`)
        .set('Cookie', cookies)
        .set('X-Locoomo-Client', 'web')
        .send(body),
    patch: (url: string, body: object = {}) =>
      http()
        .patch(`/api/v1${url}`)
        .set('Cookie', cookies)
        .set('X-Locoomo-Client', 'web')
        .send(body),
    delete: (url: string) =>
      http()
        .delete(`/api/v1${url}`)
        .set('Cookie', cookies)
        .set('X-Locoomo-Client', 'web'),
  });

  const code = (response: request.Response): string =>
    (response.body as ErrorBody).error.code;
  const data = <T>(response: request.Response): T =>
    (response.body as Envelope<T>).data;

  // Simulates the browser's direct Cloudinary upload into the signed folder.
  async function upload(cookies: string[], name: string): Promise<string> {
    const signature = data<{ folder: string }>(
      await as(cookies).post('/merchant/account/uploads').expect(200),
    );
    const publicId = `${signature.folder}/${name}`;
    cloudinary.uploaded.add(publicId);
    return publicId;
  }

  async function latestEmailTo(email: string): Promise<{
    subject: string;
    text: string;
  }> {
    const [row] = await dataSource.query<
      { payload: { subject: string; text: string } }[]
    >(
      `SELECT payload FROM outbox_events
        WHERE "eventType" = 'email' AND payload->>'to' = $1
        ORDER BY "createdAt" DESC LIMIT 1`,
      [email],
    );
    return row?.payload;
  }

  // A business merchant with every onboarding section filled in.
  async function onboardBusiness(
    owner: UserEntity,
    tradingName = 'Ada Stores',
  ): Promise<{ cookies: string[]; merchantId: string }> {
    const cookies = await signIn(owner);
    const created = data<Overview>(
      await as(cookies)
        .post('/merchant/account', { type: 'business', tradingName })
        .expect(201),
    );
    await as(cookies)
      .patch('/merchant/account/profile', {
        legalName: 'Ada Stores Limited',
        category: 'fashion',
        contactEmail: `ops-${owner.firstName}@${DOMAIN}`,
        contactPhone: '+2348031234567',
        expectedMonthlyVolume: 'up_to_10k',
        address: { line1: '1 Allen Avenue', city: 'Ikeja', state: 'Lagos' },
        cacNumber: 'rc 1234567',
      })
      .expect(200);
    await as(cookies)
      .put('/merchant/account/documents/cac_certificate', {
        publicId: await upload(cookies, 'cac.pdf'),
      })
      .expect(200);
    await as(cookies)
      .post('/merchant/account/directors', {
        fullName: 'Ada Okafor',
        idType: 'nin',
        idNumber: '12345678901',
        idDocumentPublicId: await upload(cookies, 'nin.jpg'),
      })
      .expect(201);
    await as(cookies)
      .put('/merchant/account/bank-account', {
        bankCode: '058',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      })
      .expect(200);
    await as(cookies)
      .post('/merchant/account/terms', {
        version: CURRENT_MERCHANT_TERMS_VERSION,
      })
      .expect(200);
    return { cookies, merchantId: created.merchant.id };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CloudinaryService)
      .useValue(cloudinary)
      .overrideProvider(PaystackBankService)
      .useValue(banks)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    users = moduleFixture.get(getRepositoryToken(UserEntity));
    dataSource = moduleFixture.get(DataSource);
    jwt = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    try {
      const pattern = `%@${DOMAIN}`;
      await dataSource.query(
        `DELETE FROM audit_events WHERE "merchantId" IN (SELECT m.id FROM merchants m JOIN users u ON u.id = m."createdByUserId" WHERE u.email LIKE $1)
            OR "actorId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM merchants WHERE "createdByUserId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [pattern],
      );
      await dataSource.query(
        `DELETE FROM outbox_events WHERE payload->>'to' LIKE $1`,
        [pattern],
      );
      await dataSource.query(`DELETE FROM users WHERE email LIKE $1`, [
        pattern,
      ]);
    } finally {
      await app.close();
    }
  });

  describe('creating a merchant', () => {
    it('needs a verified email, and admins can never create one', async () => {
      const unverified = await makeUser('unverified', {
        emailVerifiedAt: null,
      });
      const response = await as(await signIn(unverified))
        .post('/merchant/account', { type: 'business', tradingName: 'Nope' })
        .expect(403);
      expect(code(response)).toBe('EMAIL_NOT_VERIFIED');

      const admin = await makeAdmin('admin-creator', [AdminPermission.SUPER]);
      const adminResponse = await as(await signIn(admin))
        .post('/merchant/account', { type: 'business', tradingName: 'Nope' })
        .expect(403);
      expect(code(adminResponse)).toBe('ADMINS_CANNOT_JOIN_MERCHANTS');
    });

    it('makes the creator the owner of a draft, once', async () => {
      const owner = await makeUser('creator');
      const cookies = await signIn(owner);
      const created = data<Overview>(
        await as(cookies)
          .post('/merchant/account', {
            type: 'business',
            tradingName: '  Kwik Deals ',
          })
          .expect(201),
      );
      expect(created.merchant.status).toBe('draft');
      expect(created.me.role).toBe('owner');
      expect(created.me.permissions).toContain('ownership');
      expect(created.onboarding.readyToSubmit).toBe(false);
      expect(created.onboarding.editable).toBe(true);

      const again = await as(cookies)
        .post('/merchant/account', { type: 'individual', tradingName: 'Two' })
        .expect(409);
      expect(code(again)).toBe('ALREADY_A_MERCHANT_MEMBER');
    });

    it('refuses merchant routes to people without a merchant', async () => {
      const outsider = await makeUser('outsider');
      const response = await as(await signIn(outsider))
        .get('/merchant/account')
        .expect(403);
      expect(code(response)).toBe('NOT_A_MERCHANT_MEMBER');
    });
  });

  describe('onboarding rules', () => {
    it('only accepts files uploaded into the merchant’s own folder', async () => {
      const owner = await makeUser('uploader');
      const cookies = await signIn(owner);
      await as(cookies)
        .post('/merchant/account', { type: 'business', tradingName: 'Up' })
        .expect(201);

      cloudinary.uploaded.add('merchants/someone-else/kyc/cac.pdf');
      const foreign = await as(cookies)
        .put('/merchant/account/documents/cac_certificate', {
          publicId: 'merchants/someone-else/kyc/cac.pdf',
        })
        .expect(422);
      expect(code(foreign)).toBe('UPLOAD_NOT_FOUND');

      const signature = data<{ folder: string }>(
        await as(cookies).post('/merchant/account/uploads').expect(200),
      );
      const neverUploaded = await as(cookies)
        .put('/merchant/account/documents/cac_certificate', {
          publicId: `${signature.folder}/missing.pdf`,
        })
        .expect(422);
      expect(code(neverUploaded)).toBe('UPLOAD_NOT_FOUND');
    });

    it('asks for step-up before setting the bank account, and resolves the name', async () => {
      const owner = await makeUser('banker');
      const stale = staleSession(owner);
      await as(stale)
        .post('/merchant/account', { type: 'business', tradingName: 'Bank' })
        .expect(201);
      const body = {
        bankCode: '058',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      };
      const refused = await as(stale)
        .put('/merchant/account/bank-account', body)
        .expect(403);
      expect(code(refused)).toBe('REAUTH_REQUIRED');

      const saved = data<{ accountName: string; accountNumberLast4: string }>(
        await as(await signIn(owner))
          .put('/merchant/account/bank-account', body)
          .expect(200),
      );
      expect(saved).toMatchObject({
        accountName: 'ADA STORES LIMITED',
        accountNumberLast4: '6789',
      });
      const [row] = await dataSource.query<{ sealed: string }[]>(
        `SELECT "accountNumberSealed" AS sealed FROM merchant_bank_accounts b
           JOIN merchants m ON m.id = b."merchantId"
          WHERE m."createdByUserId" = $1`,
        [owner.id],
      );
      expect(row.sealed).not.toContain('0123456789');
    });

    it('refuses outdated terms and lists what is missing on submit', async () => {
      const owner = await makeUser('incomplete');
      const cookies = await signIn(owner);
      await as(cookies)
        .post('/merchant/account', { type: 'business', tradingName: 'Inc' })
        .expect(201);
      const outdated = await as(cookies)
        .post('/merchant/account/terms', { version: '2001-01-01' })
        .expect(409);
      expect(code(outdated)).toBe('TERMS_VERSION_OUTDATED');
      expect((outdated.body as ErrorBody).error.details).toEqual({
        currentVersion: CURRENT_MERCHANT_TERMS_VERSION,
      });

      const submit = await as(cookies)
        .post('/merchant/account/submit')
        .expect(422);
      expect(code(submit)).toBe('ONBOARDING_INCOMPLETE');
      const sections = (
        (submit.body as ErrorBody).error.details as {
          sections: { key: string }[];
        }
      ).sections.map((s) => s.key);
      expect(sections).toEqual([
        'profile',
        'business_registration',
        'directors',
        'bank_account',
        'terms',
      ]);
    });

    it('limits individual sellers to one owner ID and no CAC', async () => {
      const owner = await makeUser('individual');
      const cookies = await signIn(owner);
      await as(cookies)
        .post('/merchant/account', { type: 'individual', tradingName: 'Ada' })
        .expect(201);
      const cac = await as(cookies)
        .patch('/merchant/account/profile', { cacNumber: 'BN123456' })
        .expect(422);
      expect(code(cac)).toBe('NOT_APPLICABLE_TO_INDIVIDUALS');

      const director = {
        fullName: 'Ada Okafor',
        idType: 'passport',
        idNumber: 'A12345678',
      };
      await as(cookies)
        .post('/merchant/account/directors', {
          ...director,
          idDocumentPublicId: await upload(cookies, 'passport.jpg'),
        })
        .expect(201);
      const second = await as(cookies)
        .post('/merchant/account/directors', {
          ...director,
          idDocumentPublicId: await upload(cookies, 'passport2.jpg'),
        })
        .expect(409);
      expect(code(second)).toBe('DIRECTOR_LIMIT_REACHED');
    });
  });

  describe('submission and review', () => {
    it('runs submit → changes requested → resubmit → approve end to end', async () => {
      const owner = await makeUser('journey');
      const kyc = await makeAdmin('kyc-reviewer', [AdminPermission.KYC]);
      const ops = await makeAdmin('ops-only', [AdminPermission.OPS]);
      const { cookies, merchantId } = await onboardBusiness(owner);

      // Ready, then submitted: KYC reviewers and the team are emailed.
      const ready = data<Overview>(
        await as(cookies).get('/merchant/account').expect(200),
      );
      expect(ready.onboarding.readyToSubmit).toBe(true);
      const submitted = data<Overview>(
        await as(cookies).post('/merchant/account/submit').expect(200),
      );
      expect(submitted.merchant.status).toBe('submitted');
      expect(submitted.onboarding.editable).toBe(false);
      expect((await latestEmailTo(kyc.email)).subject).toBe(
        'KYC review: Ada Stores',
      );
      expect((await latestEmailTo(owner.email)).subject).toContain('received');

      // Frozen while under review.
      const frozen = await as(cookies)
        .patch('/merchant/account/profile', { category: 'electronics' })
        .expect(409);
      expect(code(frozen)).toBe('MERCHANT_NOT_EDITABLE');

      // The queue shows it, oldest first, with its waiting time.
      const admin = as(await signIn(kyc));
      const queue = data<{
        items: { id: string; waitingHours: number | null }[];
      }>(await admin.get('/admin/merchants?status=submitted').expect(200));
      const entry = queue.items.find((item) => item.id === merchantId);
      expect(entry?.waitingHours).toBe(0);

      const detail = data<{
        bankAccount: { nameMatch: { level: string } };
        documents: { id: string; kind: string }[];
        directors: { id: string }[];
        team: { members: { email: string; role: string }[] };
      }>(await admin.get(`/admin/merchants/${merchantId}`).expect(200));
      expect(detail.bankAccount.nameMatch.level).toBe('strong');
      expect(detail.team.members).toEqual([
        expect.objectContaining({ email: owner.email, role: 'owner' }),
      ]);

      // KYC files: short-lived links, the full ID number, every view audited.
      const link = data<{ url: string }>(
        await admin
          .post(
            `/admin/merchants/${merchantId}/documents/${detail.documents[0].id}/link`,
          )
          .expect(200),
      );
      expect(link.url).toContain('ttl=300');
      const identity = data<{ idNumber: string }>(
        await admin
          .post(
            `/admin/merchants/${merchantId}/directors/${detail.directors[0].id}/identity`,
          )
          .expect(200),
      );
      expect(identity.idNumber).toBe('12345678901');
      const views = await dataSource.query<{ action: string }[]>(
        `SELECT action FROM audit_events WHERE "merchantId" = $1 AND action LIKE 'merchant.kyc_%' ORDER BY "createdAt"`,
        [merchantId],
      );
      expect(views.map((v) => v.action)).toEqual([
        'merchant.kyc_document_viewed',
        'merchant.kyc_identity_viewed',
      ]);

      // Ops can't make KYC decisions.
      await as(await signIn(ops))
        .post(`/admin/merchants/${merchantId}/approve`, {})
        .expect(403);

      // Reject one section → can't approve → request changes.
      const reviewed = data<{ merchant: { status: string } }>(
        await admin
          .post(`/admin/merchants/${merchantId}/review`, {
            items: [
              { key: 'profile', decision: 'accepted' },
              {
                key: 'bank_account',
                decision: 'rejected',
                reason: 'Use an account in the business name',
              },
            ],
          })
          .expect(200),
      );
      expect(reviewed.merchant.status).toBe('in_review');
      const blocked = await admin
        .post(`/admin/merchants/${merchantId}/approve`, {})
        .expect(409);
      expect(code(blocked)).toBe('REVIEW_HAS_REJECTED_ITEMS');
      await admin
        .post(`/admin/merchants/${merchantId}/request-changes`, {
          note: 'Almost there',
        })
        .expect(200);
      expect((await latestEmailTo(owner.email)).text).toContain(
        'Settlement bank account: Use an account in the business name',
      );

      // The merchant sees which section and why; fixing it clears the verdict.
      const asked = data<Overview>(
        await as(cookies).get('/merchant/account').expect(200),
      );
      expect(asked.merchant).toMatchObject({
        status: 'changes_requested',
        decisionNote: 'Almost there',
      });
      expect(asked.onboarding.readyToSubmit).toBe(false);
      expect(
        asked.onboarding.items.find((i) => i.key === 'bank_account')?.review,
      ).toEqual({
        decision: 'rejected',
        reason: 'Use an account in the business name',
      });
      const notYet = await as(cookies)
        .post('/merchant/account/submit')
        .expect(422);
      expect(code(notYet)).toBe('ONBOARDING_INCOMPLETE');

      await as(cookies)
        .put('/merchant/account/bank-account', {
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '9876543210',
        })
        .expect(200);
      await as(cookies).post('/merchant/account/submit').expect(200);

      // Approve with a tier and a limit override.
      const approved = data<{
        merchant: {
          status: string;
          tier: string;
          limits: { liveShipmentsPerDay: number | null };
        };
        reviews: { key: string; decision: string }[];
      }>(
        await admin
          .post(`/admin/merchants/${merchantId}/approve`, {
            tier: 'enterprise',
            limits: { liveShipmentsPerDay: 500000 },
          })
          .expect(200),
      );
      expect(approved.merchant).toMatchObject({
        status: 'approved',
        tier: 'enterprise',
        limits: { liveShipmentsPerDay: 500000 },
      });
      expect(approved.reviews.every((r) => r.decision === 'accepted')).toBe(
        true,
      );
      expect((await latestEmailTo(owner.email)).subject).toBe(
        'Ada Stores is approved on Locoomo',
      );

      // After approval: identity details locked, contact details editable.
      const locked = await as(cookies)
        .patch('/merchant/account/profile', { legalName: 'Other Ltd' })
        .expect(409);
      expect(code(locked)).toBe('MERCHANT_DETAILS_LOCKED');
      await as(cookies)
        .patch('/merchant/account/profile', { contactPhone: '08031112222' })
        .expect(200);

      // Changing the bank account once live sends a security email.
      await as(cookies)
        .put('/merchant/account/bank-account', {
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '1111222233',
        })
        .expect(200);
      expect((await latestEmailTo(owner.email)).subject).toContain(
        'settlement bank account was changed',
      );

      // Suspend (ops) blocks edits; reinstating restores "approved".
      const opsAdmin = as(await signIn(ops));
      await opsAdmin
        .post(`/admin/merchants/${merchantId}/suspend`, {
          reason: 'Chargeback investigation',
        })
        .expect(200);
      const suspendedEdit = await as(cookies)
        .patch('/merchant/account/profile', { contactPhone: '08030000000' })
        .expect(409);
      expect(code(suspendedEdit)).toBe('MERCHANT_NOT_EDITABLE');
      const reinstated = data<{ merchant: { status: string } }>(
        await opsAdmin
          .post(`/admin/merchants/${merchantId}/reinstate`)
          .expect(200),
      );
      expect(reinstated.merchant.status).toBe('approved');

      const actions = await dataSource.query<{ action: string }[]>(
        `SELECT action FROM audit_events WHERE "merchantId" = $1 AND action IN ('merchant.submitted','merchant.review_started','merchant.changes_requested','merchant.approved','merchant.suspended','merchant.reinstated') ORDER BY "createdAt"`,
        [merchantId],
      );
      expect(actions.map((a) => a.action)).toEqual([
        'merchant.submitted',
        'merchant.review_started',
        'merchant.changes_requested',
        'merchant.submitted',
        'merchant.approved',
        'merchant.suspended',
        'merchant.reinstated',
      ]);
    });

    it('rejects with a reason, and refuses decisions on drafts', async () => {
      const owner = await makeUser('rejected');
      const { cookies, merchantId } = await onboardBusiness(owner, 'Shady');
      const admin = as(
        await signIn(await makeAdmin('kyc-2', [AdminPermission.KYC])),
      );
      const draft = await admin
        .post(`/admin/merchants/${merchantId}/approve`, {})
        .expect(409);
      expect(code(draft)).toBe('INVALID_MERCHANT_TRANSITION');

      await as(cookies).post('/merchant/account/submit').expect(200);
      const noReason = await admin
        .post(`/admin/merchants/${merchantId}/request-changes`, {})
        .expect(422);
      expect(code(noReason)).toBe('NO_REJECTED_ITEMS');
      await admin
        .post(`/admin/merchants/${merchantId}/reject`, {
          reason: 'Prohibited goods',
        })
        .expect(200);
      const seen = data<Overview>(
        await as(cookies).get('/merchant/account').expect(200),
      );
      expect(seen.merchant).toMatchObject({
        status: 'rejected',
        decisionNote: 'Prohibited goods',
      });
    });
  });

  describe('team', () => {
    it('invites, accepts, enforces roles, transfers ownership and lets members leave', async () => {
      const owner = await makeUser('team-owner');
      const teammate = await makeUser('teammate');
      const stranger = await makeUser('stranger');
      const ownerCookies = await signIn(owner);
      const merchant = data<Overview>(
        await as(ownerCookies)
          .post('/merchant/account', { type: 'business', tradingName: 'Team' })
          .expect(201),
      );

      await as(ownerCookies)
        .post('/merchant/team/invites', {
          email: teammate.email.toUpperCase(),
          role: 'developer',
        })
        .expect(201);
      const invite = await latestEmailTo(teammate.email);
      const token = /token=([A-Za-z0-9_-]+)/.exec(invite.text)?.[1];
      expect(token).toBeDefined();

      // Anyone holding the link can see what it's for…
      const preview = data<{ merchantName: string; role: string }>(
        await http()
          .post('/api/v1/merchant/invites/preview')
          .send({ token })
          .expect(200),
      );
      expect(preview).toMatchObject({
        merchantName: 'Team',
        role: 'developer',
      });

      // …but only the invited address can accept it.
      const mismatch = await as(await signIn(stranger))
        .post('/merchant/invites/accept', { token })
        .expect(403);
      expect(code(mismatch)).toBe('INVITE_EMAIL_MISMATCH');

      const teammateCookies = await signIn(teammate);
      await as(teammateCookies)
        .post('/merchant/invites/accept', { token })
        .expect(200);
      const reused = await as(await signIn(stranger))
        .post('/merchant/invites/accept', { token })
        .expect(404);
      expect(code(reused)).toBe('INVALID_MERCHANT_INVITE');

      // Developers can't touch the business profile or the team.
      const teammateView = data<Overview>(
        await as(teammateCookies).get('/merchant/account').expect(200),
      );
      expect(teammateView.me.role).toBe('developer');
      expect(teammateView.me.permissions).toEqual([
        'shipments.read',
        'shipments.write',
        'developers.manage',
      ]);
      const denied = await as(teammateCookies)
        .patch('/merchant/account/profile', { category: 'x' })
        .expect(403);
      expect(code(denied)).toBe('MERCHANT_PERMISSION_DENIED');

      const team = data<{
        members: { id: string; email: string; role: string }[];
      }>(await as(ownerCookies).get('/merchant/team').expect(200));
      const member = team.members.find((m) => m.email === teammate.email)!;
      const ownerMember = team.members.find((m) => m.email === owner.email)!;

      // Role changes take effect on the member's next request.
      await as(ownerCookies)
        .patch(`/merchant/team/members/${member.id}`, { role: 'admin' })
        .expect(200);
      await as(teammateCookies)
        .patch('/merchant/account/profile', { category: 'books' })
        .expect(200);

      const protectedOwner = await as(ownerCookies)
        .delete(`/merchant/team/members/${ownerMember.id}`)
        .expect(409);
      expect(code(protectedOwner)).toBe('OWNER_ROLE_PROTECTED');

      await as(ownerCookies)
        .post('/merchant/team/transfer-ownership', { memberId: member.id })
        .expect(204);
      const after = data<{ members: { email: string; role: string }[] }>(
        await as(ownerCookies).get('/merchant/team').expect(200),
      );
      expect(
        Object.fromEntries(after.members.map((m) => [m.email, m.role])),
      ).toEqual({ [owner.email]: 'admin', [teammate.email]: 'owner' });

      // The former owner leaves; they no longer have merchant access.
      await as(ownerCookies).delete('/merchant/team/members/me').expect(204);
      const gone = await as(ownerCookies).get('/merchant/account').expect(403);
      expect(code(gone)).toBe('NOT_A_MERCHANT_MEMBER');
      expect(merchant.merchant.id).toBeDefined();
    });
  });

  describe('closing', () => {
    it('needs step-up, removes the team and frees the owner to start again', async () => {
      const owner = await makeUser('closer');
      const stale = staleSession(owner);
      await as(stale)
        .post('/merchant/account', { type: 'individual', tradingName: 'Bye' })
        .expect(201);
      const refused = await as(stale)
        .post('/merchant/account/close')
        .expect(403);
      expect(code(refused)).toBe('REAUTH_REQUIRED');

      const fresh = await signIn(owner);
      await as(fresh).post('/merchant/account/close').expect(204);
      const after = await as(fresh).get('/merchant/account').expect(403);
      expect(code(after)).toBe('NOT_A_MERCHANT_MEMBER');
      await as(fresh)
        .post('/merchant/account', { type: 'individual', tradingName: 'Again' })
        .expect(201);
    });
  });
});
