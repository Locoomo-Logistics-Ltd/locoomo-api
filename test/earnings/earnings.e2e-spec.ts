import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { RevenueSplitEntryEntity } from '../../src/modules/earnings/infrastructure/entities/revenue-split-entry.entity';
import { RevenueSplitPartyType } from '../../src/modules/earnings/domain/party-type.enum';
import { RevenueSplitRuleEntity } from '../../src/modules/earnings/infrastructure/entities/revenue-split-rule.entity';
import { HandoffCodeEntity } from '../../src/modules/handoffs/infrastructure/entities/handoff-code.entity';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { NodeOperatorProfileEntity } from '../../src/modules/node-operators/infrastructure/entities/node-operator-profile.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { OutboxEventEntity } from '../../src/modules/notifications/infrastructure/entities/outbox-event.entity';
import { OrderEventEntity } from '../../src/modules/orders/infrastructure/entities/order-event.entity';
import { OrderEntity } from '../../src/modules/orders/infrastructure/entities/order.entity';
import {
  PaymentInitializeParams,
  PaymentInitializeResult,
  PaymentProvider,
  PaymentRefundResult,
  PaymentVerificationResult,
  PaymentVerificationStatus,
  PaymentWebhookEvent,
} from '../../src/modules/payments/domain/ports/payment-provider.port';
import { PaymentIntentEntity } from '../../src/modules/payments/infrastructure/entities/payment-intent.entity';
import { PricingRuleEntity } from '../../src/modules/payments/infrastructure/entities/pricing-rule.entity';
import { PaystackPaymentProvider } from '../../src/modules/payments/infrastructure/paystack-payment-provider';
import { RiderStatus } from '../../src/modules/riders/domain/rider-status.enum';
import { RiderProfileEntity } from '../../src/modules/riders/infrastructure/entities/rider-profile.entity';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

const VALID_SIGNATURE = 'valid-test-signature';

// Same fake-provider approach as handoffs.e2e-spec.ts.
class FakePaystackPaymentProvider implements PaymentProvider {
  private readonly transactions = new Map<
    string,
    { amountKobo: number; status: PaymentVerificationStatus }
  >();

  initialize(
    params: PaymentInitializeParams,
  ): Promise<PaymentInitializeResult> {
    this.transactions.set(params.reference, {
      amountKobo: params.amountKobo,
      status: 'pending',
    });
    return Promise.resolve({
      authorizationUrl: `https://fake.paystack.test/pay/${params.reference}`,
      providerReference: params.reference,
    });
  }

  verify(providerReference: string): Promise<PaymentVerificationResult> {
    const tx = this.transactions.get(providerReference);
    if (!tx) {
      throw new Error(`Unknown fake transaction ${providerReference}`);
    }
    return Promise.resolve({
      status: tx.status,
      amountKobo: tx.amountKobo,
      currency: 'NGN',
      paidAt: tx.status === 'success' ? new Date() : null,
      providerReference,
    });
  }

  refund(): Promise<PaymentRefundResult> {
    return Promise.resolve({
      status: 'processed',
      providerRefundReference: 'fake-refund',
    });
  }

  verifyWebhookSignature(_rawBody: Buffer, signatureHeader?: string): boolean {
    return signatureHeader === VALID_SIGNATURE;
  }

  parseWebhookEvent(rawBody: Buffer): PaymentWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      data: { reference: string };
    };
    const type =
      payload.event === 'charge.success'
        ? ('charge.success' as const)
        : payload.event === 'charge.failed'
          ? ('charge.failed' as const)
          : ('unknown' as const);
    return { type, providerReference: payload.data.reference };
  }

  markPaid(reference: string): void {
    const tx = this.transactions.get(reference);
    if (tx) {
      tx.status = 'success';
    }
  }
}

describe('Earnings (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let nodes: Repository<NodeEntity>;
  let pricingRules: Repository<PricingRuleEntity>;
  let revenueSplitRules: Repository<RevenueSplitRuleEntity>;
  let revenueSplitEntries: Repository<RevenueSplitEntryEntity>;
  let paymentIntents: Repository<PaymentIntentEntity>;
  let orders: Repository<OrderEntity>;
  let orderEvents: Repository<OrderEventEntity>;
  let riderProfiles: Repository<RiderProfileEntity>;
  let nodeOperatorProfiles: Repository<NodeOperatorProfileEntity>;
  let handoffCodes: Repository<HandoffCodeEntity>;
  let outboxEvents: Repository<OutboxEventEntity>;
  let jwtService: JwtService;
  let fakePaystack: FakePaystackPaymentProvider;
  let adminCookie: string;
  let originNodeId: string;
  let destinationNodeId: string;
  let originOperatorCookie: string;
  let destinationOperatorCookie: string;
  let riderCookie: string;
  let riderId: string;

  const emailPattern = '%@earnings.e2e.test';
  const nodeNamePattern = 'earnings.e2e.test%';
  const receiverEmail = 'receiver@earnings.e2e.test';
  const password = 'Correct-Horse-Battery-1';

  function asAdmin(req: request.Test): request.Test {
    return req.set('Cookie', [adminCookie]);
  }

  async function registerAndLogin(
    email: string,
    role: UserRole,
  ): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Tester',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role,
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const setCookie = response.headers['set-cookie'] as unknown as string[];
    const accessCookie = setCookie.find((c) => c.startsWith('access_token='));
    if (!accessCookie) {
      throw new Error('No access_token cookie in login response');
    }
    return accessCookie.split(';')[0];
  }

  async function createNodeOperator(
    email: string,
    nodeId: string,
  ): Promise<string> {
    const cookie = await registerAndLogin(email, UserRole.NODE_OPERATOR);
    const user = await users.findOneByOrFail({ email });
    await nodeOperatorProfiles.save(
      nodeOperatorProfiles.create({ userId: user.id, nodeId }),
    );
    return cookie;
  }

  async function createNode(name: string): Promise<string> {
    const response = await asAdmin(
      request(app.getHttpServer()).post('/api/v1/nodes'),
    )
      .send({
        name: `${nodeNamePattern.replace('%', '')}${name}`,
        address: '1 Test Avenue',
        city: 'Lagos',
        state: 'Lagos',
        latitude: 6.45,
        longitude: 3.47,
        capacity: 500,
      })
      .expect(201);
    return (response.body as SuccessBody).data.id as string;
  }

  async function extractLatestCollectionCode(): Promise<string> {
    const event = await outboxEvents
      .createQueryBuilder('o')
      .where('o."eventType" = \'email\'')
      .andWhere("o.payload ->> 'to' = :to", { to: receiverEmail })
      .orderBy('o."createdAt"', 'DESC')
      .getOneOrFail();
    const text = (event.payload as { text: string }).text;
    const match = /\b(\d{6})\b/.exec(text);
    if (!match) {
      throw new Error(`No 6-digit code found in email to ${receiverEmail}`);
    }
    return match[1];
  }

  // Drives a freshly-paid order through the entire handoffs pipeline
  // (drop-off -> accept -> pickup -> arrival -> intake -> collect) using the
  // shared rider/operators set up in beforeAll, landing it at COMPLETED —
  // the only state that produces revenue-split entries. Deliberately
  // duplicates handoffs.e2e-spec.ts's helper shape rather than importing
  // from it (e2e fixtures aren't shared production code, and each e2e file
  // in this codebase is self-contained).
  async function completeOrder(consumerEmail: string): Promise<{
    orderId: string;
    amountKobo: number;
    destinationFeeKobo: number;
  }> {
    const consumerCookie = await registerAndLogin(
      consumerEmail,
      UserRole.CONSUMER,
    );
    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/payments/intents')
      .set('Cookie', [consumerCookie])
      .send({
        originNodeId,
        destinationNodeId,
        receiverFullName: 'Receiver Tester',
        receiverEmail,
        receiverPhone: '+2348012345678',
        parcelDescription: 'A small box of test fixtures',
        parcelSize: 'small',
      })
      .expect(201);
    const intentId = (createResponse.body as SuccessBody).data.id as string;
    fakePaystack.markPaid(intentId);

    await request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/paystack')
      .set('x-paystack-signature', VALID_SIGNATURE)
      .send({ event: 'charge.success', data: { reference: intentId } })
      .expect(200);

    const order = await orders.findOneByOrFail({ paymentIntentId: intentId });
    const orderId = order.id;

    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
      .set('Cookie', [originOperatorCookie])
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/accept`)
      .set('Cookie', [riderCookie])
      .expect(200);

    for (const [type, operatorCookie] of [
      ['rider_pickup', originOperatorCookie],
      ['rider_arrival', destinationOperatorCookie],
    ] as const) {
      const codeResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type })
        .expect(201);
      const code = (codeResponse.body as SuccessBody).data.code as string;
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [operatorCookie])
        .send({ type, code })
        .expect(200);
    }

    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/intake`)
      .set('Cookie', [destinationOperatorCookie])
      .expect(200);

    const collectionCode = await extractLatestCollectionCode();
    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/collect`)
      .set('Cookie', [destinationOperatorCookie])
      .send({ code: collectionCode, identityConfirmed: true })
      .expect(200);

    return {
      orderId,
      amountKobo: order.amountKobo,
      destinationFeeKobo: order.destinationFeeKobo,
    };
  }

  beforeAll(async () => {
    fakePaystack = new FakePaystackPaymentProvider();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PaystackPaymentProvider)
      .useValue(fakePaystack)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    nodes = moduleFixture.get(getRepositoryToken(NodeEntity));
    pricingRules = moduleFixture.get(getRepositoryToken(PricingRuleEntity));
    revenueSplitRules = moduleFixture.get(
      getRepositoryToken(RevenueSplitRuleEntity),
    );
    revenueSplitEntries = moduleFixture.get(
      getRepositoryToken(RevenueSplitEntryEntity),
    );
    paymentIntents = moduleFixture.get(getRepositoryToken(PaymentIntentEntity));
    orders = moduleFixture.get(getRepositoryToken(OrderEntity));
    orderEvents = moduleFixture.get(getRepositoryToken(OrderEventEntity));
    riderProfiles = moduleFixture.get(getRepositoryToken(RiderProfileEntity));
    nodeOperatorProfiles = moduleFixture.get(
      getRepositoryToken(NodeOperatorProfileEntity),
    );
    handoffCodes = moduleFixture.get(getRepositoryToken(HandoffCodeEntity));
    outboxEvents = moduleFixture.get(getRepositoryToken(OutboxEventEntity));
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@earnings.e2e.test',
        passwordHash: await hashPassword(password),
        firstName: 'Admin',
        lastName: 'Tester',
        phone: '+2348012345678',
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
      }),
    );
    const adminToken = jwtService.sign({ sub: admin.id, role: UserRole.ADMIN });
    adminCookie = `access_token=${adminToken}`;

    await asAdmin(request(app.getHttpServer()).post('/api/v1/admin/pricing'))
      .send({ baseFeeNaira: 500, perKmRateNaira: 100, destinationFeeNaira: 50 })
      .expect(201);
    await asAdmin(
      request(app.getHttpServer()).post('/api/v1/admin/revenue-split'),
    )
      .send({ riderPercent: 60, nodePercent: 20, platformPercent: 20 })
      .expect(201);

    originNodeId = await createNode('origin');
    destinationNodeId = await createNode('destination');

    originOperatorCookie = await createNodeOperator(
      'origin-operator@earnings.e2e.test',
      originNodeId,
    );
    destinationOperatorCookie = await createNodeOperator(
      'destination-operator@earnings.e2e.test',
      destinationNodeId,
    );

    riderCookie = await registerAndLogin(
      'rider@earnings.e2e.test',
      UserRole.RIDER,
    );
    const riderUser = await users.findOneByOrFail({
      email: 'rider@earnings.e2e.test',
    });
    riderId = riderUser.id;
    await riderProfiles.save(
      riderProfiles.create({
        userId: riderId,
        currentEmployer: 'Test Dispatch Co',
        status: RiderStatus.ACTIVE,
      }),
    );
  });

  afterAll(async () => {
    // FK-ordered: revenue_split_entries -> (orders, revenue_split_rules) ->
    // handoff_codes/order_events -> orders -> payment_intents -> nodes ->
    // pricing_rules/revenue_split_rules -> users.
    try {
      await revenueSplitEntries
        .createQueryBuilder()
        .delete()
        .where(
          '"orderId" IN (SELECT id FROM orders WHERE "originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern))',
          { pattern: nodeNamePattern },
        )
        .execute();
      await outboxEvents
        .createQueryBuilder()
        .delete()
        .where("payload ->> 'to' LIKE :pattern", { pattern: emailPattern })
        .execute();
      await handoffCodes
        .createQueryBuilder()
        .delete()
        .where(
          '"orderId" IN (SELECT id FROM orders WHERE "originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern))',
          { pattern: nodeNamePattern },
        )
        .execute();
      await orderEvents
        .createQueryBuilder()
        .delete()
        .where(
          '"orderId" IN (SELECT id FROM orders WHERE "originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern))',
          { pattern: nodeNamePattern },
        )
        .execute();
      await orders
        .createQueryBuilder()
        .delete()
        .where(
          '"originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern)',
          { pattern: nodeNamePattern },
        )
        .execute();
      await paymentIntents
        .createQueryBuilder()
        .delete()
        .where(
          '"originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern)',
          { pattern: nodeNamePattern },
        )
        .execute();
      await nodes
        .createQueryBuilder()
        .delete()
        .where('name LIKE :pattern', { pattern: nodeNamePattern })
        .execute();
      await pricingRules
        .createQueryBuilder()
        .delete()
        .where(
          '"createdByAdminId" IN (SELECT id FROM users WHERE email LIKE :pattern)',
          { pattern: emailPattern },
        )
        .execute();
      await revenueSplitRules
        .createQueryBuilder()
        .delete()
        .where(
          '"createdByAdminId" IN (SELECT id FROM users WHERE email LIKE :pattern)',
          { pattern: emailPattern },
        )
        .execute();
      await users
        .createQueryBuilder()
        .delete()
        .where('email LIKE :pattern', { pattern: emailPattern })
        .execute();
    } finally {
      await app.close();
    }
  });

  describe('POST /admin/revenue-split', () => {
    it('creates a rule', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).post('/api/v1/admin/revenue-split'),
      )
        .send({ riderPercent: 70, nodePercent: 15, platformPercent: 15 })
        .expect(201);

      const data = (response.body as SuccessBody).data;
      expect(data.riderPercent).toBe(70);
      expect(data.nodePercent).toBe(15);
      expect(data.platformPercent).toBe(15);
      expect(data.createdByAdminEmail).toBe('admin@earnings.e2e.test');

      // Restore the 60/20/20 rule the rest of this suite depends on being
      // "current" (latest effectiveFrom wins).
      await asAdmin(
        request(app.getHttpServer()).post('/api/v1/admin/revenue-split'),
      )
        .send({ riderPercent: 60, nodePercent: 20, platformPercent: 20 })
        .expect(201);
    });

    it("rejects percentages that don't sum to 100", async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).post('/api/v1/admin/revenue-split'),
      )
        .send({ riderPercent: 60, nodePercent: 20, platformPercent: 30 })
        .expect(400);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_REVENUE_SPLIT',
      );
    });

    it('rejects a non-Admin role', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/revenue-split')
        .set('Cookie', [originOperatorCookie])
        .send({ riderPercent: 60, nodePercent: 20, platformPercent: 20 })
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/revenue-split')
        .send({ riderPercent: 60, nodePercent: 20, platformPercent: 20 })
        .expect(401);
    });
  });

  describe('GET /admin/revenue-split', () => {
    it('lists rule history', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).get(
          '/api/v1/admin/revenue-split?limit=100',
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { riderPercent: number }[];
      };
      expect(data.items.length).toBeGreaterThan(0);
    });
  });

  describe('revenue split recorded on order completion', () => {
    it('creates exactly 4 entries (rider 60%, origin Node 20%, destination Node fee, platform 20% remainder) summing to amountKobo', async () => {
      const { orderId, amountKobo, destinationFeeKobo } = await completeOrder(
        'split-consumer@earnings.e2e.test',
      );
      const deliveryRevenueKobo = amountKobo - destinationFeeKobo;

      const entries = await revenueSplitEntries.findBy({ orderId });
      expect(entries).toHaveLength(4);

      const riderEntry = entries.find(
        (e) => e.partyType === RevenueSplitPartyType.RIDER,
      );
      const nodeEntry = entries.find(
        (e) => e.partyType === RevenueSplitPartyType.NODE,
      );
      const destinationNodeEntry = entries.find(
        (e) => e.partyType === RevenueSplitPartyType.DESTINATION_NODE,
      );
      const platformEntry = entries.find(
        (e) => e.partyType === RevenueSplitPartyType.PLATFORM,
      );

      expect(riderEntry?.partyId).toBe(riderId);
      expect(nodeEntry?.partyId).toBe(originNodeId);
      expect(destinationNodeEntry?.partyId).toBe(destinationNodeId);
      expect(platformEntry?.partyId).toBeNull();

      // The 60/20/20 split runs on delivery revenue only (amountKobo minus
      // the destination fee) — the destination fee is a dedicated 100%
      // pass-through, not folded into the split.
      expect(riderEntry?.amountKobo).toBe(
        Math.floor(deliveryRevenueKobo * 0.6),
      );
      expect(nodeEntry?.amountKobo).toBe(Math.floor(deliveryRevenueKobo * 0.2));
      expect(destinationNodeEntry?.amountKobo).toBe(destinationFeeKobo);
      expect(
        (riderEntry?.amountKobo ?? 0) +
          (nodeEntry?.amountKobo ?? 0) +
          (destinationNodeEntry?.amountKobo ?? 0) +
          (platformEntry?.amountKobo ?? 0),
      ).toBe(amountKobo);

      for (const entry of entries) {
        expect(entry.payoutStatus).toBe('pending');
        expect(entry.splitRuleId).toBeTruthy();
      }
    });

    it('does not double-record on a duplicate confirm (idempotent with the COMPLETED transition)', async () => {
      const { orderId } = await completeOrder(
        'idempotent-consumer@earnings.e2e.test',
      );

      // Any code works here — an already-COMPLETED order's collect call
      // short-circuits via the idempotency guard before the code is ever
      // checked, same as the collect endpoint's own idempotent-duplicate-
      // confirm test in handoffs.e2e-spec.ts.
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code: '000000', identityConfirmed: true })
        .expect(200);

      const entries = await revenueSplitEntries.findBy({ orderId });
      expect(entries).toHaveLength(4);
    });
  });

  describe('GET /earnings/mine', () => {
    it("lists the rider's own entry for a completed order", async () => {
      const { orderId, amountKobo, destinationFeeKobo } = await completeOrder(
        'rider-mine-consumer@earnings.e2e.test',
      );
      const deliveryRevenueKobo = amountKobo - destinationFeeKobo;

      const response = await request(app.getHttpServer())
        .get('/api/v1/earnings/mine')
        .set('Cookie', [riderCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: {
          orderId: string;
          partyType: string;
          amountKobo: number;
          payoutStatus: string;
        }[];
      };
      const item = data.items.find((row) => row.orderId === orderId);
      expect(item).toBeDefined();
      expect(item?.partyType).toBe('rider');
      expect(item?.amountKobo).toBe(Math.floor(deliveryRevenueKobo * 0.6));
      expect(item?.payoutStatus).toBe('pending');
    });

    it('rejects a non-Rider role', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/earnings/mine')
        .set('Cookie', [originOperatorCookie])
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/earnings/mine')
        .expect(401);
    });
  });

  describe('GET /earnings/my-node', () => {
    it("lists the origin operator's own Node entry (20% cut) but not a destination-fee entry, for a completed order", async () => {
      const { orderId, amountKobo, destinationFeeKobo } = await completeOrder(
        'node-mine-consumer@earnings.e2e.test',
      );
      const deliveryRevenueKobo = amountKobo - destinationFeeKobo;

      const response = await request(app.getHttpServer())
        .get('/api/v1/earnings/my-node?limit=100')
        .set('Cookie', [originOperatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { orderId: string; partyType: string; amountKobo: number }[];
      };
      const forOrder = data.items.filter((row) => row.orderId === orderId);
      expect(forOrder).toHaveLength(1);
      expect(forOrder[0].partyType).toBe('node');
      expect(forOrder[0].amountKobo).toBe(
        Math.floor(deliveryRevenueKobo * 0.2),
      );
    });

    it("lists the destination operator's own destination-fee entry, not the origin Node's 20% cut", async () => {
      const { orderId, destinationFeeKobo } = await completeOrder(
        'node-dest-consumer@earnings.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/earnings/my-node?limit=100')
        .set('Cookie', [destinationOperatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { orderId: string; partyType: string; amountKobo: number }[];
      };
      const forOrder = data.items.filter((row) => row.orderId === orderId);
      expect(forOrder).toHaveLength(1);
      expect(forOrder[0].partyType).toBe('destination_node');
      expect(forOrder[0].amountKobo).toBe(destinationFeeKobo);
    });

    it('rejects a non-NodeOperator role', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/earnings/my-node')
        .set('Cookie', [riderCookie])
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/earnings/my-node')
        .expect(401);
    });
  });

  describe('GET /admin/revenue-split/entries', () => {
    beforeAll(async () => {
      // Verified payout account for the rider only — proves Admin sees
      // payoutAccountConfigured true for the rider and false for a Node
      // that never set one up, without needing to fake PaystackBankService
      // in this suite (the verification flow itself is covered in
      // riders.e2e-spec.ts/node-operators.e2e-spec.ts).
      await riderProfiles.update(
        { userId: riderId },
        {
          payoutBankCode: '058',
          payoutBankName: 'GTBank',
          payoutAccountNumber: '0123456789',
          payoutAccountName: 'Rider Tester',
          payoutAccountVerifiedAt: new Date(),
        },
      );
    });

    it('lists all 4 party entries for a completed order, with payout account visibility', async () => {
      const { orderId } = await completeOrder(
        'admin-list-consumer@earnings.e2e.test',
      );

      const response = await asAdmin(
        request(app.getHttpServer()).get(
          '/api/v1/admin/revenue-split/entries?limit=100',
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: {
          orderId: string;
          partyType: string;
          partyLabel: string;
          payoutAccountConfigured: boolean;
          payoutBankName: string | null;
          payoutAccountNumber: string | null;
        }[];
      };
      const forOrder = data.items.filter((row) => row.orderId === orderId);
      expect(forOrder).toHaveLength(4);
      const platformRow = forOrder.find((row) => row.partyType === 'platform');
      expect(platformRow?.partyLabel).toBe('Platform');
      expect(platformRow?.payoutAccountConfigured).toBe(false);
      const riderRow = forOrder.find((row) => row.partyType === 'rider');
      expect(riderRow?.partyLabel).toBe('rider@earnings.e2e.test');
      expect(riderRow?.payoutAccountConfigured).toBe(true);
      expect(riderRow?.payoutBankName).toBe('GTBank');
      expect(riderRow?.payoutAccountNumber).toBe('0123456789');
      const nodeRow = forOrder.find((row) => row.partyType === 'node');
      expect(nodeRow?.payoutAccountConfigured).toBe(false);
      const destinationNodeRow = forOrder.find(
        (row) => row.partyType === 'destination_node',
      );
      expect(destinationNodeRow?.partyLabel).toBe(
        `${nodeNamePattern.replace('%', '')}destination`,
      );
      expect(destinationNodeRow?.payoutAccountConfigured).toBe(false);
    });

    it('filters by partyType', async () => {
      const { orderId } = await completeOrder(
        'admin-filter-consumer@earnings.e2e.test',
      );

      const response = await asAdmin(
        request(app.getHttpServer()).get(
          '/api/v1/admin/revenue-split/entries?limit=100&partyType=rider',
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { orderId: string; partyType: string }[];
      };
      const forOrder = data.items.filter((row) => row.orderId === orderId);
      expect(forOrder).toHaveLength(1);
      expect(forOrder[0].partyType).toBe('rider');
    });

    it('rejects a non-Admin role', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/revenue-split/entries')
        .set('Cookie', [riderCookie])
        .expect(403);
    });
  });

  describe('PATCH /admin/revenue-split/entries/:id/mark-paid', () => {
    it('marks an entry paid and records who/when', async () => {
      const { orderId } = await completeOrder(
        'mark-paid-consumer@earnings.e2e.test',
      );
      const [entry] = await revenueSplitEntries.findBy({
        orderId,
        partyType: RevenueSplitPartyType.RIDER,
      });

      const response = await asAdmin(
        request(app.getHttpServer()).patch(
          `/api/v1/admin/revenue-split/entries/${entry.id}/mark-paid`,
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data;
      expect(data.payoutStatus).toBe('paid');
      expect(data.paidAt).not.toBeNull();
      expect(data.paidByAdminEmail).toBe('admin@earnings.e2e.test');

      // Idempotent — marking again is a no-op success, not an error.
      const secondResponse = await asAdmin(
        request(app.getHttpServer()).patch(
          `/api/v1/admin/revenue-split/entries/${entry.id}/mark-paid`,
        ),
      ).expect(200);
      const secondData = (secondResponse.body as SuccessBody).data;
      expect(secondData.payoutStatus).toBe('paid');
      expect(secondData.paidByAdminEmail).toBe('admin@earnings.e2e.test');
    });

    it('404s for a non-existent entry', async () => {
      await asAdmin(
        request(app.getHttpServer()).patch(
          '/api/v1/admin/revenue-split/entries/00000000-0000-0000-0000-000000000000/mark-paid',
        ),
      ).expect(404);
    });

    it('rejects a non-Admin role', async () => {
      await request(app.getHttpServer())
        .patch(
          '/api/v1/admin/revenue-split/entries/00000000-0000-0000-0000-000000000000/mark-paid',
        )
        .set('Cookie', [riderCookie])
        .expect(403);
    });
  });
});
