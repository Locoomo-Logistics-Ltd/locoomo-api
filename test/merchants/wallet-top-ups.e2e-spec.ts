import { createHmac, randomUUID } from 'crypto';
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
import { WalletTopUpService } from '../../src/modules/merchants/application/wallet-top-up.service';
import {
  PaystackKeyEnv,
  PaystackWalletGateway,
  WalletCharge,
} from '../../src/modules/payments/application/paystack-wallet.gateway';

const PASSWORD = 'Correct-Horse-Battery-1';
const DOMAIN = 'topups.e2e.test';
const FUNDING = 100_000_000;

interface ErrorBody {
  error: { code: string; details?: unknown };
}
interface TopUp {
  id: string;
  mode: string;
  method: string;
  status: string;
  amountKobo: number;
  feeKobo: number;
  creditedKobo: number | null;
  reference: string;
}
interface Wallet {
  balanceKobo: number;
  heldKobo: number;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
interface FundingAccount {
  bankName: string;
  accountNumber: string;
  accountName: string;
}

// Stands in for Paystack: charges are whatever the test says they are.
class FakeWalletGateway {
  charges = new Map<string, WalletCharge>();
  customers: { code: string; id: number }[] = [];
  initialized: {
    env: PaystackKeyEnv;
    reference: string;
    amountKobo: number;
  }[] = [];
  customerCalls = 0;

  keyFor(): string {
    return 'sk_test_fake';
  }
  isAvailable(): boolean {
    return true;
  }
  isTestKeySignature(): boolean {
    return false;
  }
  initializeCardTopUp(
    env: PaystackKeyEnv,
    input: { reference: string; amountKobo: number },
  ): Promise<{ authorizationUrl: string }> {
    this.initialized.push({ env, ...input });
    return Promise.resolve({
      authorizationUrl: `https://checkout.paystack.test/${input.reference}`,
    });
  }
  verify(
    _env: PaystackKeyEnv,
    reference: string,
  ): Promise<WalletCharge | null> {
    return Promise.resolve(this.charges.get(reference) ?? null);
  }
  createCustomer(): Promise<{ customerCode: string; customerId: number }> {
    this.customerCalls++;
    const customer = {
      code: `CUS_${randomUUID().slice(0, 8)}`,
      id: 1000 + this.customers.length,
    };
    this.customers.push(customer);
    return Promise.resolve({
      customerCode: customer.code,
      customerId: customer.id,
    });
  }
  createDedicatedAccount(): Promise<{
    providerAccountId: string;
    accountNumber: string;
    accountName: string;
    bankName: string;
    bankSlug: string;
  }> {
    return Promise.resolve({
      providerAccountId: '42',
      accountNumber: '9930000001',
      accountName: 'LOCOOMO/TOPUP STORES WALLET',
      bankName: 'Test Bank',
      bankSlug: 'test-bank',
    });
  }
  successfulCharges(
    _env: PaystackKeyEnv,
    customerId: number,
  ): Promise<WalletCharge[]> {
    const code = this.customers.find((c) => c.id === customerId)?.code;
    return Promise.resolve(
      [...this.charges.values()].filter(
        (c) => c.status === 'success' && c.customerCode === code,
      ),
    );
  }

  succeed(reference: string, amountKobo: number, feeKobo: number): void {
    this.charges.set(reference, {
      reference,
      status: 'success',
      amountKobo,
      feeKobo,
      channel: 'card',
      customerCode: null,
      paidAt: new Date(),
    });
  }
  transfer(customerCode: string, amountKobo: number): string {
    const reference = `T${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    this.charges.set(reference, {
      reference,
      status: 'success',
      amountKobo,
      feeKobo: 50,
      channel: 'dedicated_nuban',
      customerCode,
      paidAt: new Date(),
    });
    return reference;
  }
}

function cookiesFrom(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((cookie) => cookie.split(';')[0]);
}

describe('Merchant wallet top-ups (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let dataSource: DataSource;
  let owner: string[];
  let finance: string[];
  let merchantId: string;
  let key: string;
  const paystack = new FakeWalletGateway();

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const code = (response: request.Response): string =>
    (response.body as ErrorBody).error.code;
  const data = <T>(response: request.Response): T =>
    (response.body as { data: T }).data;

  const dashboard = (mode: 'test' | 'live') => ({
    get: (url: string) =>
      http()
        .get(`/api/v1/merchant${url}`)
        .set('Cookie', owner)
        .set('Locoomo-Mode', mode),
    post: (url: string, body: object = {}) =>
      http()
        .post(`/api/v1/merchant${url}`)
        .set('Cookie', owner)
        .set('X-Locoomo-Client', 'web')
        .set('Locoomo-Mode', mode)
        .send(body),
  });
  const wallet = async (mode: 'test' | 'live'): Promise<Wallet> =>
    data<Wallet>(await dashboard(mode).get('/wallet').expect(200));

  // Signed exactly like Paystack: HMAC-SHA512 of the raw body.
  function webhook(data: Record<string, unknown>) {
    const body = JSON.stringify({ event: 'charge.success', data });
    const signature = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
      .update(body)
      .digest('hex');
    return http()
      .post('/api/v1/payments/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(body);
  }

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

  async function startCard(mode: 'test' | 'live', amountKobo: number) {
    return data<{ topUp: TopUp; authorizationUrl: string }>(
      await dashboard(mode).post('/wallet/top-ups', { amountKobo }).expect(201),
    );
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PaystackWalletGateway)
      .useValue(paystack)
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

    finance = await signIn(
      await makeUser('finance', {
        role: UserRole.ADMIN,
        adminPermissions: [AdminPermission.FINANCE],
      }),
    );
    owner = await signIn(await makeUser('owner'));
    merchantId = data<{ merchant: { id: string } }>(
      await http()
        .post('/api/v1/merchant/account')
        .set('Cookie', owner)
        .send({ type: 'individual', tradingName: 'Topup Stores' })
        .expect(201),
    ).merchant.id;
    key = data<{ secret: string }>(
      await http()
        .post('/api/v1/merchant/api-keys')
        .set('Cookie', owner)
        .send({ mode: 'test', name: 'k', kind: 'secret' })
        .expect(201),
    ).secret;
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
        `DELETE FROM idempotency_keys WHERE scope LIKE 'payments.webhook%' AND key IN (SELECT reference FROM wallet_top_ups WHERE "merchantId" IN (${owned}))`,
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
      await dataSource.query(`DELETE FROM users WHERE email LIKE $1`, [
        pattern,
      ]);
    } finally {
      await app.close();
    }
  });

  describe('card top-ups', () => {
    it('credits the amount minus the card fee once, however often Paystack calls', async () => {
      const started = await startCard('test', 500_000);
      expect(started.topUp).toMatchObject({
        mode: 'test',
        method: 'card',
        status: 'pending',
        amountKobo: 500_000,
        creditedKobo: null,
      });
      expect(started.authorizationUrl).toContain(started.topUp.reference);
      expect(paystack.initialized.at(-1)).toMatchObject({
        env: 'test',
        amountKobo: 500_000,
      });

      paystack.succeed(started.topUp.reference, 500_000, 7_500);
      await webhook({ reference: started.topUp.reference }).expect(200);
      await webhook({ reference: started.topUp.reference }).expect(200);

      expect((await wallet('test')).balanceKobo).toBe(FUNDING + 492_500);
      const topUp = data<TopUp>(
        await dashboard('test')
          .get(`/wallet/top-ups/${started.topUp.id}`)
          .expect(200),
      );
      expect(topUp).toMatchObject({
        status: 'succeeded',
        feeKobo: 7_500,
        creditedKobo: 492_500,
      });
      const entries = data<Page<{ type: string; amountKobo: number }>>(
        await dashboard('test').get('/wallet/entries?type=top_up').expect(200),
      );
      expect(entries.items).toEqual([
        expect.objectContaining({ type: 'top_up', amountKobo: 492_500 }),
      ]);

      const [event] = await dataSource.query<{ body: string }[]>(
        `SELECT body FROM webhook_events WHERE "merchantId" = $1 AND type = 'wallet.funded'`,
        [merchantId],
      );
      expect(JSON.parse(event.body)).toMatchObject({
        type: 'wallet.funded',
        mode: 'test',
        data: {
          topUp: { id: started.topUp.id, creditedKobo: 492_500 },
          wallet: { balanceKobo: FUNDING + 492_500 },
        },
      });
    });

    it('settles on the status check when the webhook never comes', async () => {
      const before = (await wallet('test')).balanceKobo;
      const started = await startCard('test', 200_000);
      paystack.succeed(started.topUp.reference, 200_000, 3_000);
      const checked = data<TopUp>(
        await dashboard('test')
          .get(`/wallet/top-ups/${started.topUp.id}`)
          .expect(200),
      );
      expect(checked.status).toBe('succeeded');
      expect((await wallet('test')).balanceKobo).toBe(before + 197_000);
    });

    it('never credits a payment that differs from what was asked', async () => {
      const before = (await wallet('test')).balanceKobo;
      const started = await startCard('test', 300_000);
      paystack.succeed(started.topUp.reference, 100_000, 1_500);
      await webhook({ reference: started.topUp.reference }).expect(200);
      expect((await wallet('test')).balanceKobo).toBe(before);
    });

    it('is dashboard-only and validates the amount', async () => {
      await http()
        .post('/api/v1/merchant/wallet/top-ups')
        .set('Authorization', `Bearer ${key}`)
        .send({ amountKobo: 500_000 })
        .expect((response) => {
          expect([401, 403]).toContain(response.status);
        });
      expect(
        code(
          await dashboard('test')
            .post('/wallet/top-ups', { amountKobo: 50 })
            .expect(400),
        ),
      ).toBe('VALIDATION_FAILED');
      // Integrators can read them with wallet:read.
      await http()
        .get('/api/v1/merchant/wallet/top-ups')
        .set('Authorization', `Bearer ${key}`)
        .expect(200);
    });

    it('needs approval for live, then respects the wallet ceiling', async () => {
      expect(
        code(
          await dashboard('live')
            .post('/wallet/top-ups', { amountKobo: 500_000 })
            .expect(403),
        ),
      ).toBe('MERCHANT_NOT_APPROVED');

      await dataSource.query(
        `UPDATE merchants SET status = 'approved', tier = 'individual',
                "limitOverrides" = '{"maxWalletBalanceKobo": 1000000}'::jsonb
          WHERE id = $1`,
        [merchantId],
      );
      const over = await dashboard('live')
        .post('/wallet/top-ups', { amountKobo: 1_500_000 })
        .expect(422);
      expect(code(over)).toBe('WALLET_BALANCE_LIMIT_EXCEEDED');

      const live = await startCard('live', 500_000);
      expect(paystack.initialized.at(-1)).toMatchObject({ env: 'live' });
      expect(live.topUp.mode).toBe('live');
    });
  });

  describe('bank transfers to a dedicated account', () => {
    let customerCode: string;

    it('opens one account per merchant, live only, with contact details', async () => {
      expect(
        code(
          await dashboard('test').post('/wallet/funding-account').expect(403),
        ),
      ).toBe('LIVE_MODE_ONLY');
      const missing = await dashboard('live')
        .post('/wallet/funding-account')
        .expect(422);
      expect(code(missing)).toBe('CONTACT_DETAILS_REQUIRED');

      await dataSource.query(
        `UPDATE merchants SET "contactEmail" = 'ops@topup.example', "contactPhone" = '+2348031234567' WHERE id = $1`,
        [merchantId],
      );
      const opened = data<FundingAccount>(
        await dashboard('live').post('/wallet/funding-account').expect(200),
      );
      expect(opened).toMatchObject({
        bankName: 'Test Bank',
        accountNumber: '9930000001',
      });
      await dashboard('live').post('/wallet/funding-account').expect(200);
      expect(paystack.customerCalls).toBe(1);
      expect(
        data<FundingAccount | null>(
          await dashboard('live').get('/wallet/funding-account').expect(200),
        ),
      ).toMatchObject({ accountNumber: '9930000001' });
      expect(
        data<FundingAccount | null>(
          await dashboard('test').get('/wallet/funding-account').expect(200),
        ),
      ).toBeNull();
      customerCode = paystack.customers[0].code;
    });

    it('credits a transfer in full, once', async () => {
      const before = (await wallet('live')).balanceKobo;
      const reference = paystack.transfer(customerCode, 1_000_000);
      const payload = {
        reference,
        channel: 'dedicated_nuban',
        customer: { customer_code: customerCode },
      };
      await webhook(payload).expect(200);
      await webhook(payload).expect(200);
      expect((await wallet('live')).balanceKobo).toBe(before + 1_000_000);

      const list = data<Page<TopUp>>(
        await dashboard('live').get('/wallet/top-ups').expect(200),
      );
      expect(list.items[0]).toMatchObject({
        method: 'bank_transfer',
        status: 'succeeded',
        amountKobo: 1_000_000,
        feeKobo: 0,
        creditedKobo: 1_000_000,
        reference,
      });
    });

    it('ignores transfers it can’t match', async () => {
      const before = (await wallet('live')).balanceKobo;
      await webhook({
        reference: 'unknown-ref',
        channel: 'dedicated_nuban',
        customer: { customer_code: 'CUS_nobody' },
      }).expect(200);
      expect((await wallet('live')).balanceKobo).toBe(before);
    });
  });

  describe('sweep', () => {
    it('credits missed transfers, fails declined cards and abandons stale ones', async () => {
      const sweeper = app.get(WalletTopUpService);
      const before = (await wallet('live')).balanceKobo;
      const missed = paystack.transfer(paystack.customers[0].code, 250_000);

      const declined = await startCard('test', 150_000);
      paystack.charges.set(declined.topUp.reference, {
        reference: declined.topUp.reference,
        status: 'failed',
        amountKobo: 150_000,
        feeKobo: 0,
        channel: 'card',
        customerCode: null,
        paidAt: null,
      });
      const stale = await startCard('test', 160_000);
      await dataSource.query(
        `UPDATE wallet_top_ups SET "createdAt" = now() - interval '25 hours' WHERE id = $1`,
        [stale.topUp.id],
      );
      await dataSource.query(
        `UPDATE wallet_top_ups SET "createdAt" = now() - interval '5 minutes' WHERE id = $1`,
        [declined.topUp.id],
      );

      const first = await sweeper.sweep();
      expect(first.credited).toBeGreaterThanOrEqual(1);
      expect((await wallet('live')).balanceKobo).toBe(before + 250_000);
      const statuses = await dataSource.query<{ id: string; status: string }[]>(
        `SELECT id, status FROM wallet_top_ups WHERE id = ANY($1)`,
        [[declined.topUp.id, stale.topUp.id]],
      );
      expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual(
        {
          [declined.topUp.id]: 'failed',
          [stale.topUp.id]: 'abandoned',
        },
      );

      // A late success still credits an abandoned card payment.
      paystack.succeed(stale.topUp.reference, 160_000, 2_400);
      await webhook({ reference: stale.topUp.reference }).expect(200);
      expect(
        data<TopUp>(
          await dashboard('test')
            .get(`/wallet/top-ups/${stale.topUp.id}`)
            .expect(200),
        ).status,
      ).toBe('succeeded');

      await sweeper.sweep();
      expect((await wallet('live')).balanceKobo).toBe(before + 250_000);
      expect(missed).toBeTruthy();
    });
  });

  describe('admin and reconciliation', () => {
    it('shows top-ups to finance and keeps the ledger balanced', async () => {
      const list = data<Page<TopUp>>(
        await http()
          .get(`/api/v1/admin/merchants/${merchantId}/wallet/top-ups?mode=live`)
          .set('Cookie', finance)
          .expect(200),
      );
      expect(list.items.length).toBeGreaterThanOrEqual(2);

      const drift = await app.get(WalletReconciliationService).run();
      expect(drift.filter((d) => d.merchantId === merchantId)).toEqual([]);
    });
  });
});
