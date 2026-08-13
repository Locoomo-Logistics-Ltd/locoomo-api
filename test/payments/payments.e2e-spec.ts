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
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { OutboxEventEntity } from '../../src/modules/notifications/infrastructure/entities/outbox-event.entity';
import { OrderEntity } from '../../src/modules/orders/infrastructure/entities/order.entity';
import { ExpirePaymentIntentsService } from '../../src/modules/payments/application/expire-payment-intents.service';
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

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

const VALID_SIGNATURE = 'valid-test-signature';

// Fakes the Paystack boundary the same way FakeCloudinaryService fakes
// Cloudinary — PaystackPaymentProvider's HTTP/HMAC logic is out of scope for
// this suite (it talks to a real external API), so this exercises our own
// webhook/idempotency/reconciliation logic against a controllable in-memory
// provider instead.
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

  // Test-only helpers to simulate what Paystack would report on verify().
  markPaid(reference: string): void {
    const tx = this.transactions.get(reference);
    if (tx) {
      tx.status = 'success';
    }
  }

  tamperAmount(reference: string): void {
    const tx = this.transactions.get(reference);
    if (tx) {
      tx.status = 'success';
      tx.amountKobo += 100;
    }
  }
}

describe('Payments (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let nodes: Repository<NodeEntity>;
  let pricingRules: Repository<PricingRuleEntity>;
  let paymentIntents: Repository<PaymentIntentEntity>;
  let orders: Repository<OrderEntity>;
  let outboxEvents: Repository<OutboxEventEntity>;
  let jwtService: JwtService;
  let fakePaystack: FakePaystackPaymentProvider;
  let expirePaymentIntentsService: ExpirePaymentIntentsService;
  let adminCookie: string;
  let originNodeId: string;
  let destinationNodeId: string;

  const emailPattern = '%@payments.e2e.test';
  const nodeNamePattern = 'payments.e2e.test%';
  const password = 'Correct-Horse-Battery-1';

  function asAdmin(req: request.Test): request.Test {
    return req.set('Cookie', [adminCookie]);
  }

  async function registerAndLoginConsumer(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Consumer',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.CONSUMER,
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

  async function createNode(name: string, capacity: number): Promise<string> {
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
        capacity,
      })
      .expect(201);
    return (response.body as SuccessBody).data.id as string;
  }

  function createIntent(
    consumerCookie: string,
    overrides: Record<string, unknown> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/payments/intents')
      .set('Cookie', [consumerCookie])
      .send({
        originNodeId,
        destinationNodeId,
        receiverFullName: 'Receiver Tester',
        receiverEmail: 'receiver@payments.e2e.test',
        receiverPhone: '+2348012345678',
        parcelDescription: 'A small box of test fixtures',
        parcelSize: 'small',
        ...overrides,
      });
  }

  function sendWebhook(reference: string, signature: string | undefined) {
    const req = request(app.getHttpServer())
      .post('/api/v1/payments/webhooks/paystack')
      .send({ event: 'charge.success', data: { reference } });
    if (signature !== undefined) {
      req.set('x-paystack-signature', signature);
    }
    return req;
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
    paymentIntents = moduleFixture.get(getRepositoryToken(PaymentIntentEntity));
    orders = moduleFixture.get(getRepositoryToken(OrderEntity));
    outboxEvents = moduleFixture.get(getRepositoryToken(OutboxEventEntity));
    jwtService = moduleFixture.get(JwtService);
    expirePaymentIntentsService = moduleFixture.get(
      ExpirePaymentIntentsService,
    );

    const admin = await users.save(
      users.create({
        email: 'admin@payments.e2e.test',
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
      .send({ baseFeeNaira: 500, perKmRateNaira: 100 })
      .expect(201);

    originNodeId = await createNode('origin', 30);
    destinationNodeId = await createNode('destination', 30);
  });

  afterAll(async () => {
    // FK-ordered: order_events -> orders -> payment_intents -> nodes ->
    // pricing_rules -> users. Wrapped so app.close() always runs even if
    // cleanup itself fails — an unclosed app here is what actually hangs
    // the whole Jest process, not just this suite.
    try {
      await outboxEvents
        .createQueryBuilder()
        .delete()
        .where("payload ->> 'to' LIKE :pattern", { pattern: emailPattern })
        .execute();
      await orders.manager.query(
        `DELETE FROM order_events WHERE "orderId" IN (
           SELECT id FROM orders WHERE "originNodeId" IN (
             SELECT id FROM nodes WHERE name LIKE $1
           )
         )`,
        [nodeNamePattern],
      );
      await orders
        .createQueryBuilder()
        .delete()
        .where(
          '"originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern)',
          {
            pattern: nodeNamePattern,
          },
        )
        .execute();
      await paymentIntents
        .createQueryBuilder()
        .delete()
        .where(
          '"originNodeId" IN (SELECT id FROM nodes WHERE name LIKE :pattern)',
          {
            pattern: nodeNamePattern,
          },
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
          {
            pattern: emailPattern,
          },
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

  describe('POST /payments/intents', () => {
    it('creates a PENDING intent with a fee breakdown and an authorization URL', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'happy-path@payments.e2e.test',
      );

      const response = await createIntent(consumerCookie).expect(201);
      const data = (response.body as SuccessBody).data;

      expect(data.status).toBe('pending');
      expect(data.authorizationUrl).toContain('fake.paystack.test');
      expect((data.feeBreakdown as Record<string, unknown>).totalKobo).toBe(
        data.amountKobo,
      );
      expect(data.amountKobo as number).toBeGreaterThan(0);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/payments/intents')
        .send({
          originNodeId,
          destinationNodeId,
          receiverFullName: 'Receiver Tester',
          receiverEmail: 'receiver@payments.e2e.test',
          receiverPhone: '+2348012345678',
          parcelDescription: 'A parcel',
          parcelSize: 'small',
        })
        .expect(401);
    });

    it('rejects the second of two concurrent requests against a Node with one remaining slot (E1)', async () => {
      const raceNodeId = await createNode('race-origin', 1);
      const consumerA = await registerAndLoginConsumer(
        'race-a@payments.e2e.test',
      );
      const consumerB = await registerAndLoginConsumer(
        'race-b@payments.e2e.test',
      );

      const [responseA, responseB] = await Promise.all([
        createIntent(consumerA, { originNodeId: raceNodeId }),
        createIntent(consumerB, { originNodeId: raceNodeId }),
      ]);

      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const failed = responseA.status === 409 ? responseA : responseB;
      expect((failed.body as ErrorBody).error.code).toBe(
        'NODE_CAPACITY_UNAVAILABLE',
      );

      const node = await nodes.findOneBy({ id: raceNodeId });
      expect(node?.currentCount).toBe(1);
    });
  });

  describe('POST /payments/webhooks/paystack', () => {
    it('rejects a request with an invalid signature', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'bad-sig@payments.e2e.test',
      );
      const createResponse = await createIntent(consumerCookie).expect(201);
      const intentId = (createResponse.body as SuccessBody).data.id as string;
      fakePaystack.markPaid(intentId);

      const response = await sendWebhook(intentId, 'wrong-signature').expect(
        401,
      );
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_WEBHOOK_SIGNATURE',
      );

      const intent = await paymentIntents.findOneBy({ id: intentId });
      expect(intent?.status).toBe('pending');
    });

    it('marks the intent PAID and creates an Order on a valid success event', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'webhook-happy@payments.e2e.test',
      );
      const createResponse = await createIntent(consumerCookie).expect(201);
      const intentId = (createResponse.body as SuccessBody).data.id as string;
      fakePaystack.markPaid(intentId);

      await sendWebhook(intentId, VALID_SIGNATURE).expect(200);

      const intent = await paymentIntents.findOneBy({ id: intentId });
      expect(intent?.status).toBe('paid');
      expect(intent?.paidAt).not.toBeNull();

      const order = await orders.findOneBy({ paymentIntentId: intentId });
      expect(order).not.toBeNull();
      expect(order?.status).toBe('awaiting_drop_off');
      expect(order?.amountKobo).toBe(intent?.amountKobo);

      // Order-confirmation email queued through the transactional outbox
      // (decision #10) in the same transaction as the Order write above.
      const outboxEvent = await outboxEvents
        .createQueryBuilder('o')
        .where('o."eventType" = \'email\'')
        .andWhere("o.payload ->> 'to' = :to", {
          to: 'webhook-happy@payments.e2e.test',
        })
        .andWhere("o.payload ->> 'subject' = :subject", {
          subject: 'Your Locoomo order is confirmed',
        })
        .getOne();
      expect(outboxEvent).not.toBeNull();
    });

    it('is idempotent under a duplicate delivery of the same event', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'webhook-idempotent@payments.e2e.test',
      );
      const createResponse = await createIntent(consumerCookie).expect(201);
      const intentId = (createResponse.body as SuccessBody).data.id as string;
      fakePaystack.markPaid(intentId);

      await sendWebhook(intentId, VALID_SIGNATURE).expect(200);
      await sendWebhook(intentId, VALID_SIGNATURE).expect(200);

      const orderCount = await orders.countBy({ paymentIntentId: intentId });
      expect(orderCount).toBe(1);
    });

    it('does not mark an intent paid when the verified amount does not match', async () => {
      const consumerCookie = await registerAndLoginConsumer(
        'webhook-mismatch@payments.e2e.test',
      );
      const createResponse = await createIntent(consumerCookie).expect(201);
      const intentId = (createResponse.body as SuccessBody).data.id as string;
      fakePaystack.tamperAmount(intentId);

      await sendWebhook(intentId, VALID_SIGNATURE).expect(200);

      const intent = await paymentIntents.findOneBy({ id: intentId });
      expect(intent?.status).toBe('pending');

      const order = await orders.findOneBy({ paymentIntentId: intentId });
      expect(order).toBeNull();
    });
  });

  describe('ExpirePaymentIntentsService', () => {
    it('expires a stale PENDING intent and releases its Node capacity slot', async () => {
      const expiryNodeId = await createNode('expiry-origin', 5);
      const consumerCookie = await registerAndLoginConsumer(
        'expiry@payments.e2e.test',
      );
      const createResponse = await createIntent(consumerCookie, {
        originNodeId: expiryNodeId,
      }).expect(201);
      const intentId = (createResponse.body as SuccessBody).data.id as string;

      const nodeBefore = await nodes.findOneBy({ id: expiryNodeId });
      expect(nodeBefore?.currentCount).toBe(1);

      await paymentIntents.update(intentId, {
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expirePaymentIntentsService.poll();

      const intent = await paymentIntents.findOneBy({ id: intentId });
      expect(intent?.status).toBe('expired');

      const nodeAfter = await nodes.findOneBy({ id: expiryNodeId });
      expect(nodeAfter?.currentCount).toBe(0);
    });

    it('recovers a stale intent that was actually paid but never got a webhook', async () => {
      const recoverNodeId = await createNode('recover-origin', 5);
      const consumerCookie = await registerAndLoginConsumer(
        'recover@payments.e2e.test',
      );
      const createResponse = await createIntent(consumerCookie, {
        originNodeId: recoverNodeId,
      }).expect(201);
      const intentId = (createResponse.body as SuccessBody).data.id as string;
      fakePaystack.markPaid(intentId);

      await paymentIntents.update(intentId, {
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expirePaymentIntentsService.poll();

      const intent = await paymentIntents.findOneBy({ id: intentId });
      expect(intent?.status).toBe('paid');

      const order = await orders.findOneBy({ paymentIntentId: intentId });
      expect(order).not.toBeNull();

      // Recovered via payment, not expiry — the capacity slot stays held
      // (the parcel is genuinely on its way), unlike the expiry case above.
      const node = await nodes.findOneBy({ id: recoverNodeId });
      expect(node?.currentCount).toBe(1);
    });
  });
});
