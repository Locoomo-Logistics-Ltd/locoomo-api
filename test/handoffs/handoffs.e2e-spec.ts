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
import { HandoffCodeType } from '../../src/modules/handoffs/domain/handoff-code-type.enum';
import { HandoffCodeEntity } from '../../src/modules/handoffs/infrastructure/entities/handoff-code.entity';
import { NodeOperatorProfileEntity } from '../../src/modules/node-operators/infrastructure/entities/node-operator-profile.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { OrderStatus } from '../../src/modules/orders/domain/order-status.enum';
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

// Same fake-provider approach as payments.e2e-spec.ts/orders.e2e-spec.ts.
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

describe('Handoffs (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let nodes: Repository<NodeEntity>;
  let pricingRules: Repository<PricingRuleEntity>;
  let paymentIntents: Repository<PaymentIntentEntity>;
  let orders: Repository<OrderEntity>;
  let orderEvents: Repository<OrderEventEntity>;
  let riderProfiles: Repository<RiderProfileEntity>;
  let nodeOperatorProfiles: Repository<NodeOperatorProfileEntity>;
  let handoffCodes: Repository<HandoffCodeEntity>;
  let jwtService: JwtService;
  let fakePaystack: FakePaystackPaymentProvider;
  let adminCookie: string;
  let originNodeId: string;
  let destinationNodeId: string;
  let originOperatorCookie: string;
  let destinationOperatorCookie: string;

  const emailPattern = '%@handoffs.e2e.test';
  const nodeNamePattern = 'handoffs.e2e.test%';
  const password = 'Correct-Horse-Battery-1';
  const riderLat = 6.45;
  const riderLng = 3.47;

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

  // Registers a rider and directly activates their profile — bypasses the
  // full onboarding/Cloudinary/Admin-approval HTTP flow (already covered by
  // riders.e2e-spec.ts), since this suite is testing handoffs, not
  // onboarding.
  async function createActiveRider(
    email: string,
  ): Promise<{ cookie: string; userId: string }> {
    const cookie = await registerAndLogin(email, UserRole.RIDER);
    const user = await users.findOneByOrFail({ email });
    await riderProfiles.save(
      riderProfiles.create({
        userId: user.id,
        currentEmployer: 'Test Dispatch Co',
        status: RiderStatus.ACTIVE,
      }),
    );
    return { cookie, userId: user.id };
  }

  // Registers a Node operator and directly links them to an existing Node —
  // bypasses the full onboarding HTTP flow (already covered by
  // node-operators.e2e-spec.ts), since this suite is testing handoffs, not
  // onboarding.
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
        capacity: 30,
      })
      .expect(201);
    return (response.body as SuccessBody).data.id as string;
  }

  // Places and pays an order, leaving it at the natural post-payment
  // AWAITING_DROP_OFF state — the precondition for testing the drop-off
  // scan itself.
  async function createPaidOrder(
    consumerEmail: string,
  ): Promise<{ id: string; trackingCode: string }> {
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
        receiverEmail: 'receiver@handoffs.e2e.test',
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
    return { id: order.id, trackingCode: order.trackingCode };
  }

  // Skips straight to PARCEL_RECEIVED_AT_ORIGIN for suites (rider
  // assignment) that don't care about the drop-off step itself — Phase 2's
  // own tests use createPaidOrder + the real drop-off endpoint instead.
  async function createAvailableOrder(consumerEmail: string): Promise<string> {
    const { id } = await createPaidOrder(consumerEmail);
    await orders.update(id, { status: OrderStatus.PARCEL_RECEIVED_AT_ORIGIN });
    return id;
  }

  // Drives an order through the real drop-off + accept endpoints (not a
  // direct DB write) so it lands at RIDER_ASSIGNED — the precondition for
  // Phase 3's pickup-code tests.
  async function createAssignedOrder(
    consumerEmail: string,
    riderCookie: string,
  ): Promise<string> {
    const { id: orderId } = await createPaidOrder(consumerEmail);
    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
      .set('Cookie', [originOperatorCookie])
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/accept`)
      .set('Cookie', [riderCookie])
      .expect(200);
    return orderId;
  }

  // Continues an already-RIDER_ASSIGNED order through the real pickup-code
  // flow so it lands at IN_TRANSIT — the precondition for arrival-code tests.
  async function pickUp(orderId: string, riderCookie: string): Promise<void> {
    const codeResponse = await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
      .set('Cookie', [riderCookie])
      .send({ type: 'rider_pickup' })
      .expect(201);
    const code = (codeResponse.body as SuccessBody).data.code as string;

    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
      .set('Cookie', [originOperatorCookie])
      .send({ type: 'rider_pickup', code })
      .expect(200);
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
    riderProfiles = moduleFixture.get(getRepositoryToken(RiderProfileEntity));
    nodeOperatorProfiles = moduleFixture.get(
      getRepositoryToken(NodeOperatorProfileEntity),
    );
    handoffCodes = moduleFixture.get(getRepositoryToken(HandoffCodeEntity));
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@handoffs.e2e.test',
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

    originOperatorCookie = await createNodeOperator(
      'origin-operator@handoffs.e2e.test',
      originNodeId,
    );
    destinationOperatorCookie = await createNodeOperator(
      'destination-operator@handoffs.e2e.test',
      destinationNodeId,
    );
  });

  afterAll(async () => {
    try {
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
      // rider_profiles/node_operator_profiles cascade-delete with their
      // user, no explicit cleanup needed.
      await users
        .createQueryBuilder()
        .delete()
        .where('email LIKE :pattern', { pattern: emailPattern })
        .execute();
    } finally {
      await app.close();
    }
  });

  describe('GET /handoffs/available-orders', () => {
    it('lists an unclaimed order at the origin Node', async () => {
      const { cookie } = await createActiveRider(
        'browse-rider@handoffs.e2e.test',
      );
      const orderId = await createAvailableOrder(
        'browse-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/available-orders')
        .query({ latitude: riderLat, longitude: riderLng })
        .set('Cookie', [cookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string; distanceMeters: number }[];
      };
      expect(data.items.some((item) => item.id === orderId)).toBe(true);
    });

    it('rejects a non-Rider role', async () => {
      const consumerCookie = await registerAndLogin(
        'browse-forbidden@handoffs.e2e.test',
        UserRole.CONSUMER,
      );

      await request(app.getHttpServer())
        .get('/api/v1/handoffs/available-orders')
        .query({ latitude: riderLat, longitude: riderLng })
        .set('Cookie', [consumerCookie])
        .expect(403);
    });
  });

  describe('POST /handoffs/orders/:id/accept', () => {
    it('claims an available order and increments the capacity counter', async () => {
      const { cookie, userId } = await createActiveRider(
        'accept-rider@handoffs.e2e.test',
      );
      const orderId = await createAvailableOrder(
        'accept-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/accept`)
        .set('Cookie', [cookie])
        .expect(200);

      const data = (response.body as SuccessBody).data;
      expect(data.status).toBe('rider_assigned');

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.riderId).toBe(userId);

      const profile = await riderProfiles.findOneByOrFail({ userId });
      expect(profile.currentActiveOrderCount).toBe(1);
    });

    it('rejects claiming an order not yet at the origin Node', async () => {
      const { cookie } = await createActiveRider(
        'early-rider@handoffs.e2e.test',
      );
      const consumerCookie = await registerAndLogin(
        'early-consumer@handoffs.e2e.test',
        UserRole.CONSUMER,
      );
      const createResponse = await request(app.getHttpServer())
        .post('/api/v1/payments/intents')
        .set('Cookie', [consumerCookie])
        .send({
          originNodeId,
          destinationNodeId,
          receiverFullName: 'Receiver Tester',
          receiverEmail: 'receiver@handoffs.e2e.test',
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
      // Deliberately left at AWAITING_DROP_OFF — never marked received.

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${order.id}/accept`)
        .set('Cookie', [cookie])
        .expect(409);
      expect((response.body as ErrorBody).error.code).toBe(
        'ILLEGAL_ORDER_TRANSITION',
      );
    });

    it('rejects the second of two riders racing to accept the same order', async () => {
      const riderA = await createActiveRider('race-a@handoffs.e2e.test');
      const riderB = await createActiveRider('race-b@handoffs.e2e.test');
      const orderId = await createAvailableOrder(
        'race-consumer@handoffs.e2e.test',
      );

      const [responseA, responseB] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${orderId}/accept`)
          .set('Cookie', [riderA.cookie]),
        request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${orderId}/accept`)
          .set('Cookie', [riderB.cookie]),
      ]);

      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const order = await orders.findOneByOrFail({ id: orderId });
      expect([riderA.userId, riderB.userId]).toContain(order.riderId);
    });

    it('rejects a 4th concurrent delivery past the capacity cap', async () => {
      const { cookie, userId } = await createActiveRider(
        'capped-rider@handoffs.e2e.test',
      );
      // Sequential, not Promise.all — only the accept() calls below need to
      // happen in order; concurrent setup here just adds connection-pool
      // pressure with no bearing on what this test actually checks.
      const orderIds = [
        await createAvailableOrder('capped-consumer-1@handoffs.e2e.test'),
        await createAvailableOrder('capped-consumer-2@handoffs.e2e.test'),
        await createAvailableOrder('capped-consumer-3@handoffs.e2e.test'),
        await createAvailableOrder('capped-consumer-4@handoffs.e2e.test'),
      ];

      for (const orderId of orderIds.slice(0, 3)) {
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${orderId}/accept`)
          .set('Cookie', [cookie])
          .expect(200);
      }

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderIds[3]}/accept`)
        .set('Cookie', [cookie])
        .expect(409);
      expect((response.body as ErrorBody).error.code).toBe(
        'RIDER_CAPACITY_UNAVAILABLE',
      );

      const fourthOrder = await orders.findOneByOrFail({ id: orderIds[3] });
      expect(fourthOrder.riderId).toBeNull();

      const profile = await riderProfiles.findOneByOrFail({ userId });
      expect(profile.currentActiveOrderCount).toBe(3);
    });

    it('rejects a pending (not-yet-approved) rider', async () => {
      const cookie = await registerAndLogin(
        'pending-rider@handoffs.e2e.test',
        UserRole.RIDER,
      );
      const user = await users.findOneByOrFail({
        email: 'pending-rider@handoffs.e2e.test',
      });
      await riderProfiles.save(
        riderProfiles.create({
          userId: user.id,
          currentEmployer: 'Test Dispatch Co',
          status: RiderStatus.PENDING,
        }),
      );
      const orderId = await createAvailableOrder(
        'pending-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/accept`)
        .set('Cookie', [cookie])
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('RIDER_NOT_ACTIVE');
    });

    it('rejects an unauthenticated request', async () => {
      const orderId = await createAvailableOrder(
        'unauth-consumer@handoffs.e2e.test',
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/accept`)
        .expect(401);
    });
  });

  describe('GET /handoffs/orders/by-tracking-code/:code', () => {
    it("previews an order at the operator's own origin Node", async () => {
      const operatorCookie = await createNodeOperator(
        'lookup-operator@handoffs.e2e.test',
        originNodeId,
      );
      const { trackingCode } = await createPaidOrder(
        'lookup-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get(`/api/v1/handoffs/orders/by-tracking-code/${trackingCode}`)
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data;
      expect(data.trackingCode).toBe(trackingCode);
      expect(data.status).toBe('awaiting_drop_off');
      expect(data.destinationNodeName).toContain('destination');
    });

    it("404s for an order belonging to a different Node's operator", async () => {
      const otherNodeId = await createNode('lookup-other');
      const operatorCookie = await createNodeOperator(
        'lookup-wrong-operator@handoffs.e2e.test',
        otherNodeId,
      );
      const { trackingCode } = await createPaidOrder(
        'lookup-wrong-consumer@handoffs.e2e.test',
      );

      await request(app.getHttpServer())
        .get(`/api/v1/handoffs/orders/by-tracking-code/${trackingCode}`)
        .set('Cookie', [operatorCookie])
        .expect(404);
    });

    it('rejects a non-NodeOperator role', async () => {
      const { cookie } = await createActiveRider(
        'lookup-forbidden@handoffs.e2e.test',
      );

      await request(app.getHttpServer())
        .get('/api/v1/handoffs/orders/by-tracking-code/LCM-0000-0000')
        .set('Cookie', [cookie])
        .expect(403);
    });
  });

  describe('POST /handoffs/orders/:id/drop-off', () => {
    it('marks the order received at the origin Node', async () => {
      const operatorCookie = await createNodeOperator(
        'dropoff-operator@handoffs.e2e.test',
        originNodeId,
      );
      const { id: orderId } = await createPaidOrder(
        'dropoff-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data;
      expect(data.status).toBe('parcel_received_at_origin');

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.status).toBe('parcel_received_at_origin');
    });

    it('is idempotent under a duplicate confirm', async () => {
      const operatorCookie = await createNodeOperator(
        'dropoff-idempotent-operator@handoffs.e2e.test',
        originNodeId,
      );
      const { id: orderId } = await createPaidOrder(
        'dropoff-idempotent-consumer@handoffs.e2e.test',
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
        .set('Cookie', [operatorCookie])
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
        .set('Cookie', [operatorCookie])
        .expect(200);

      const eventCount = await orderEvents.countBy({
        orderId,
        type: 'parcel_received_at_origin',
      });
      expect(eventCount).toBe(1);
    });

    it("404s for an order belonging to a different Node's operator", async () => {
      const otherNodeId = await createNode('dropoff-other');
      const operatorCookie = await createNodeOperator(
        'dropoff-wrong-operator@handoffs.e2e.test',
        otherNodeId,
      );
      const { id: orderId } = await createPaidOrder(
        'dropoff-wrong-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
        .set('Cookie', [operatorCookie])
        .expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.status).toBe('awaiting_drop_off');
    });

    it('rejects a non-NodeOperator role', async () => {
      const { cookie } = await createActiveRider(
        'dropoff-forbidden@handoffs.e2e.test',
      );
      const { id: orderId } = await createPaidOrder(
        'dropoff-forbidden-consumer@handoffs.e2e.test',
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
        .set('Cookie', [cookie])
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      const { id: orderId } = await createPaidOrder(
        'dropoff-unauth-consumer@handoffs.e2e.test',
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
        .expect(401);
    });
  });

  describe('POST /handoffs/orders/:id/request-code + POST /handoffs/orders/:id/confirm-handoff', () => {
    it('completes rider pickup: assigned rider requests, origin operator confirms', async () => {
      const { cookie: riderCookie, userId: riderId } = await createActiveRider(
        'pickup-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'pickup-consumer@handoffs.e2e.test',
        riderCookie,
      );

      const codeResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);
      const code = (codeResponse.body as SuccessBody).data.code as string;
      expect(code).toMatch(/^\d{6}$/);

      const confirmResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [originOperatorCookie])
        .send({ type: 'rider_pickup', code })
        .expect(200);
      expect((confirmResponse.body as SuccessBody).data.status).toBe(
        'in_transit',
      );

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.riderId).toBe(riderId);
    });

    it('completes rider arrival after pickup: assigned rider requests, destination operator confirms', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'arrival-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'arrival-consumer@handoffs.e2e.test',
        riderCookie,
      );
      await pickUp(orderId, riderCookie);

      const codeResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_arrival' })
        .expect(201);
      const code = (codeResponse.body as SuccessBody).data.code as string;

      const confirmResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ type: 'rider_arrival', code })
        .expect(200);
      expect((confirmResponse.body as SuccessBody).data.status).toBe(
        'arrived_at_destination',
      );
    });

    it('rejects a pickup-code request from a rider who was never assigned this order', async () => {
      const { cookie: assignedCookie } = await createActiveRider(
        'unassigned-owner-rider@handoffs.e2e.test',
      );
      const { cookie: strangerCookie } = await createActiveRider(
        'unassigned-stranger-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'unassigned-consumer@handoffs.e2e.test',
        assignedCookie,
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [strangerCookie])
        .send({ type: 'rider_pickup' })
        .expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');

      // The legitimately assigned rider's own request still works —
      // confirms this isn't blocking the order generally, only the
      // unassigned rider specifically.
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [assignedCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);
    });

    it('rejects a wrong code and increments the lockout counter durably', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'wrongcode-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'wrongcode-consumer@handoffs.e2e.test',
        riderCookie,
      );
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [originOperatorCookie])
        .send({ type: 'rider_pickup', code: '000000' })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_HANDOFF_CODE',
      );

      const handoffCode = await handoffCodes.findOneByOrFail({
        orderId,
        type: HandoffCodeType.RIDER_PICKUP,
      });
      expect(handoffCode.failedAttempts).toBe(1);

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.status).toBe('rider_assigned');
    });

    it('locks the code out permanently after 5 wrong attempts, even with the right code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'lockout-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'lockout-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const codeResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);
      const code = (codeResponse.body as SuccessBody).data.code as string;

      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
          .set('Cookie', [originOperatorCookie])
          .send({ type: 'rider_pickup', code: '000000' })
          .expect(401);
      }

      // Now even the genuinely correct code is rejected — the code itself
      // is locked, not just the guesses.
      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [originOperatorCookie])
        .send({ type: 'rider_pickup', code })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_HANDOFF_CODE',
      );

      // Requesting a fresh code recovers — the rider isn't permanently
      // stuck, just that specific code.
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);
    });

    it('rejects a pickup confirm from an operator at the wrong Node', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'wrongnode-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'wrongnode-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const codeResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);
      const code = (codeResponse.body as SuccessBody).data.code as string;

      // destinationOperatorCookie, not originOperatorCookie — pickup only
      // belongs to the origin Node.
      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ type: 'rider_pickup', code })
        .expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('is idempotent under a duplicate confirm with the same code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'idempotent-pickup-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'idempotent-pickup-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const codeResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);
      const code = (codeResponse.body as SuccessBody).data.code as string;

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [originOperatorCookie])
        .send({ type: 'rider_pickup', code })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [originOperatorCookie])
        .send({ type: 'rider_pickup', code })
        .expect(200);

      const eventCount = await orderEvents.countBy({
        orderId,
        type: 'picked_up_by_rider',
      });
      expect(eventCount).toBe(1);
    });

    it('rejects an expired code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'expired-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'expired-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const codeResponse = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup' })
        .expect(201);
      const code = (codeResponse.body as SuccessBody).data.code as string;

      await handoffCodes.update(
        { orderId, type: HandoffCodeType.RIDER_PICKUP },
        { expiresAt: new Date(Date.now() - 60_000) },
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [originOperatorCookie])
        .send({ type: 'rider_pickup', code })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_HANDOFF_CODE',
      );
    });

    it('rejects a request-code call from a non-Rider role', async () => {
      const orderId = await createAvailableOrder(
        'requestcode-forbidden-consumer@handoffs.e2e.test',
      );
      const consumerCookie = await registerAndLogin(
        'requestcode-forbidden@handoffs.e2e.test',
        UserRole.CONSUMER,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
        .set('Cookie', [consumerCookie])
        .send({ type: 'rider_pickup' })
        .expect(403);
    });

    it('rejects a confirm-handoff call from a non-NodeOperator role', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'confirm-forbidden-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'confirm-forbidden-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
        .set('Cookie', [riderCookie])
        .send({ type: 'rider_pickup', code: '000000' })
        .expect(403);
    });
  });
});
