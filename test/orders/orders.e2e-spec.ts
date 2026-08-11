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
import { OrderEntity } from '../../src/modules/orders/infrastructure/entities/order.entity';
import { OrderEventEntity } from '../../src/modules/orders/infrastructure/entities/order-event.entity';
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

// Same fake-provider approach as payments.e2e-spec.ts — the only way to get
// a real, paid Order to test these read endpoints against is to drive the
// actual place-order -> pay -> webhook flow.
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

describe('Orders (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let nodes: Repository<NodeEntity>;
  let pricingRules: Repository<PricingRuleEntity>;
  let paymentIntents: Repository<PaymentIntentEntity>;
  let orders: Repository<OrderEntity>;
  let orderEvents: Repository<OrderEventEntity>;
  let jwtService: JwtService;
  let fakePaystack: FakePaystackPaymentProvider;
  let adminCookie: string;
  let originNodeId: string;
  let destinationNodeId: string;

  const emailPattern = '%@orders.e2e.test';
  const nodeNamePattern = 'orders.e2e.test%';
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
        capacity: 30,
      })
      .expect(201);
    return (response.body as SuccessBody).data.id as string;
  }

  // Places an order, pays it, and confirms it via the webhook — returns the
  // consumer's auth cookie and the resulting Order id.
  async function placeAndPayOrder(
    email: string,
  ): Promise<{ consumerCookie: string; orderId: string }> {
    const consumerCookie = await registerAndLoginConsumer(email);
    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/payments/intents')
      .set('Cookie', [consumerCookie])
      .send({
        originNodeId,
        destinationNodeId,
        receiverFullName: 'Receiver Tester',
        receiverEmail: 'receiver@orders.e2e.test',
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
    return { consumerCookie, orderId: order.id };
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
    orderEvents = moduleFixture.get(getRepositoryToken(OrderEventEntity));
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@orders.e2e.test',
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

    originNodeId = await createNode('origin');
    destinationNodeId = await createNode('destination');
  });

  afterAll(async () => {
    // FK-ordered: order_events -> orders -> payment_intents -> nodes ->
    // pricing_rules -> users, wrapped so app.close() always runs.
    try {
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
      await users
        .createQueryBuilder()
        .delete()
        .where('email LIKE :pattern', { pattern: emailPattern })
        .execute();
    } finally {
      await app.close();
    }
  });

  describe('GET /orders/:id', () => {
    it("returns the consumer's own order", async () => {
      const { consumerCookie, orderId } = await placeAndPayOrder(
        'own-order@orders.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Cookie', [consumerCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data;
      expect(data.id).toBe(orderId);
      expect(data.status).toBe('awaiting_drop_off');
      expect(data.receiverFullName).toBe('Receiver Tester');
      expect(data.trackingCode).toMatch(/^LCM-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(data.originNodeId).toBe(originNodeId);
      expect(data.originNodeName).toContain('origin');
      expect(data.originNodeAddress).toBe('1 Test Avenue');
      expect(data.destinationNodeId).toBe(destinationNodeId);
      expect(data.destinationNodeName).toContain('destination');
    });

    it("404s on another consumer's order (ownership-scoped, not a 403)", async () => {
      const { orderId } = await placeAndPayOrder('owner@orders.e2e.test');
      const otherCookie = await registerAndLoginConsumer(
        'other@orders.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Cookie', [otherCookie])
        .expect(404);

      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('rejects an unauthenticated request', async () => {
      const { orderId } = await placeAndPayOrder(
        'unauthenticated@orders.e2e.test',
      );

      await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .expect(401);
    });
  });

  describe('GET /orders', () => {
    it("lists only the requesting consumer's own orders, paginated", async () => {
      const { consumerCookie, orderId: firstOrderId } = await placeAndPayOrder(
        'list-a@orders.e2e.test',
      );
      const { orderId: secondOrderId } = await placeAndPayOrder(
        'list-b@orders.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Cookie', [consumerCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string }[];
        page: number;
        limit: number;
        total: number;
      };
      const ids = data.items.map((item) => item.id);
      expect(ids).toContain(firstOrderId);
      expect(ids).not.toContain(secondOrderId);
      expect(data.page).toBe(1);
      expect(data.total).toBeGreaterThanOrEqual(1);
    });
  });
});
