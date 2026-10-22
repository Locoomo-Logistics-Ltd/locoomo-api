import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { RevenueSplitEntryEntity } from '../../src/modules/earnings/infrastructure/entities/revenue-split-entry.entity';
import { RevenueSplitRuleEntity } from '../../src/modules/earnings/infrastructure/entities/revenue-split-rule.entity';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { HandoffCodeType } from '../../src/modules/handoffs/domain/handoff-code-type.enum';
import { HandoffCodeEntity } from '../../src/modules/handoffs/infrastructure/entities/handoff-code.entity';
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { OutboxEventEntity } from '../../src/modules/notifications/infrastructure/entities/outbox-event.entity';
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
import { OutboxHandlerRegistry } from '../../src/modules/notifications/application/outbox-handler.registry';
import { DeliveryEventsService } from '../../src/modules/logistics/application/delivery-events.service';
import { DeliveryReconcilerService } from '../../src/modules/logistics/application/delivery-reconciler.service';
import { LogisticsProviderRegistry } from '../../src/modules/logistics/application/logistics-provider.registry';
import {
  DeliveryEventType,
  DeliveryLegStatus,
  VehicleClass,
} from '../../src/modules/logistics/domain/delivery-leg';
import {
  CreateDeliveryRequest,
  CreateDeliveryResult,
  HandoverCodes,
  LogisticsProvider,
  LogisticsProviderError,
  ProviderCapabilities,
  ProviderDeliverySnapshot,
  ProviderWebhookEvent,
} from '../../src/modules/logistics/domain/ports/logistics-provider.port';
import { DeliveryLegEntity } from '../../src/modules/logistics/infrastructure/entities/delivery-leg.entity';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

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

// Stands in for an external courier (Sendii-like): remote submission, its
// own handover codes, progress reported by webhook and readable by polling.
// Keeps its own view of each delivery, as a real provider does.
class FakeCourierProvider implements LogisticsProvider {
  readonly key = 'fake_courier';
  readonly capabilities: ProviderCapabilities = {
    vehicleClasses: [VehicleClass.MOTORBIKE, VehicleClass.CAR],
    handover: 'provider_code',
    updates: 'webhook',
    remoteSubmission: true,
    cancellableUntil: DeliveryLegStatus.ASSIGNED,
    prepaidWallet: false,
  };
  requests: CreateDeliveryRequest[] = [];
  cancelled: string[] = [];
  failNext: Error | null = null;
  failCodes = false;
  deliveries = new Map<
    string,
    { status: DeliveryLegStatus; sequence: number }
  >();

  createDelivery(
    request: CreateDeliveryRequest,
  ): Promise<CreateDeliveryResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    this.requests.push(request);
    const externalId = `fake-${request.legId}`;
    this.deliveries.set(externalId, {
      status: DeliveryLegStatus.REQUESTED,
      sequence: 1,
    });
    return Promise.resolve({
      externalId,
      status: DeliveryLegStatus.REQUESTED,
      providerStatus: 'pending',
      quotedKobo: 150000,
      trackingUrl: null,
      etaMinutes: 25,
    });
  }

  // What the courier now says about a delivery (its own state moves on).
  advance(externalId: string, status: DeliveryLegStatus): void {
    const delivery = this.deliveries.get(externalId)!;
    delivery.status = status;
    delivery.sequence += 1;
  }

  cancel(externalId: string | null): Promise<void> {
    if (externalId) {
      this.cancelled.push(externalId);
      this.advance(externalId, DeliveryLegStatus.CANCELLED);
    }
    return Promise.resolve();
  }

  getDelivery(externalId: string): Promise<ProviderDeliverySnapshot> {
    const delivery = this.deliveries.get(externalId)!;
    return Promise.resolve({
      externalId,
      status: delivery.status,
      providerStatus: delivery.status,
      sequence: delivery.sequence,
      courier: {
        name: 'Musa A.',
        phone: '+2348031112222',
        vehicle: 'motorbike',
      },
      trackingUrl: null,
      actualKobo: null,
      surchargeKobo: 0,
      failureReason: null,
    });
  }

  getHandoverCodes(externalId: string): Promise<HandoverCodes> {
    if (this.failCodes) {
      return Promise.reject(
        new LogisticsProviderError(this.key, 'getHandoverCodes', 'down', true),
      );
    }
    const { status } = this.deliveries.get(externalId)!;
    return Promise.resolve({
      pickupCode: status === DeliveryLegStatus.ASSIGNED ? '111111' : null,
      deliveryCode:
        status === DeliveryLegStatus.PICKED_UP ||
        status === DeliveryLegStatus.RETURNING
          ? '222222'
          : null,
    });
  }

  verifyWebhook(_raw: Buffer, headers: Record<string, string | undefined>) {
    return headers['x-fake-signature'] === 'valid';
  }

  parseWebhook(raw: Buffer): ProviderWebhookEvent {
    const body = JSON.parse(raw.toString('utf8')) as {
      id: string;
      externalId: string | null;
      event: DeliveryEventType | null;
      status: DeliveryLegStatus;
    };
    return {
      eventId: body.id,
      externalId: body.externalId,
      event: body.event,
      snapshot: null,
    };
  }
}

describe('Handoffs (e2e)', () => {
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
  let nodeMemberships: Repository<NodeMembershipEntity>;
  let handoffCodes: Repository<HandoffCodeEntity>;
  let outboxEvents: Repository<OutboxEventEntity>;
  let jwtService: JwtService;
  let fakePaystack: FakePaystackPaymentProvider;
  let adminCookie: string;
  let originNodeId: string;
  let destinationNodeId: string;
  let originOperatorCookie: string;
  let destinationOperatorCookie: string;

  const emailPattern = '%@handoffs.e2e.test';
  const nodeNamePattern = 'handoffs.e2e.test%';
  // createPaidOrder hardcodes this as every order's receiver — fine for
  // this suite since no test asserts cross-order isolation of receiver
  // identity, only of the collection code itself.
  const receiverEmail = 'receiver@handoffs.e2e.test';
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
    await nodeMemberships.save(
      nodeMemberships.create({ userId: user.id, nodeId }),
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
        // High headroom, not a realistic pilot value — origin capacity is
        // only released on rider pickup (decision #6/#4), and most of this
        // suite's ~60 tests place an order against the shared origin Node
        // without ever picking it up, so runtime consumption is much
        // higher than the test count naively suggests.
        capacity: 500,
        ...NODE_CONTACT_FIELDS,
      })
      .expect(201);
    return (response.body as SuccessBody).data.id as string;
  }

  // Places and pays an order, leaving it at the natural post-payment
  // AWAITING_DROP_OFF state — the precondition for testing the drop-off
  // scan itself.
  async function createPaidOrder(
    consumerEmail: string,
    fromNodeId: string = originNodeId,
  ): Promise<{ id: string; trackingCode: string; consumerCookie: string }> {
    const consumerCookie = await registerAndLogin(
      consumerEmail,
      UserRole.CONSUMER,
    );
    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/payments/intents')
      .set('Cookie', [consumerCookie])
      .send({
        originNodeId: fromNodeId,
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
    return {
      id: order.id,
      trackingCode: order.trackingCode,
      consumerCookie,
    };
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

  // Continues an already-IN_TRANSIT order through the real arrival-code
  // flow so it lands at ARRIVED_AT_DESTINATION — the precondition for
  // Phase 4's intake tests.
  async function arrive(orderId: string, riderCookie: string): Promise<void> {
    const codeResponse = await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/request-code`)
      .set('Cookie', [riderCookie])
      .send({ type: 'rider_arrival' })
      .expect(201);
    const code = (codeResponse.body as SuccessBody).data.code as string;

    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/confirm-handoff`)
      .set('Cookie', [destinationOperatorCookie])
      .send({ type: 'rider_arrival', code })
      .expect(200);
  }

  // Drives an order all the way to ARRIVED_AT_DESTINATION via the real
  // drop-off/accept/pickup/arrival endpoints — the precondition for Phase
  // 4's intake tests.
  async function createArrivedOrder(
    consumerEmail: string,
    riderCookie: string,
  ): Promise<string> {
    const orderId = await createAssignedOrder(consumerEmail, riderCookie);
    await pickUp(orderId, riderCookie);
    await arrive(orderId, riderCookie);
    return orderId;
  }

  // Drives an order through the real intake endpoint so it lands at
  // READY_FOR_COLLECTION — the precondition for Phase 4's collect/resend
  // tests.
  async function createReadyForCollectionOrder(
    consumerEmail: string,
    riderCookie: string,
  ): Promise<string> {
    const orderId = await createArrivedOrder(consumerEmail, riderCookie);
    await request(app.getHttpServer())
      .post(`/api/v1/handoffs/orders/${orderId}/intake`)
      .set('Cookie', [destinationOperatorCookie])
      .expect(200);
    return orderId;
  }

  // The receiver's collection code is only ever delivered by email (never
  // by API response — see ResendCollectionCodeService), so tests recover it
  // the same way a real receiver would: by reading the most recent
  // queued email addressed to them. Safe because Jest runs `it()` blocks
  // in this file sequentially, so "most recent" always means "the one this
  // test's own action just enqueued."
  async function extractLatestCollectionCode(
    receiverEmail: string,
  ): Promise<string> {
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
    nodeMemberships = moduleFixture.get(
      getRepositoryToken(NodeMembershipEntity),
    );
    handoffCodes = moduleFixture.get(getRepositoryToken(HandoffCodeEntity));
    outboxEvents = moduleFixture.get(getRepositoryToken(OutboxEventEntity));
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
      .send({ baseFeeNaira: 500, perKmRateNaira: 100, destinationFeeNaira: 50 })
      .expect(201);
    // /collect hard-depends on a configured revenue-split rule (earnings
    // module) — same reasoning as pricing above, this suite drives orders
    // all the way to COMPLETED, so it needs its own rule rather than
    // relying on whichever one happens to be "current" from another suite.
    await asAdmin(
      request(app.getHttpServer()).post('/api/v1/admin/revenue-split'),
    )
      .send({ riderPercent: 60, nodePercent: 20, platformPercent: 20 })
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
      // revenue_split_entries has a real FK to orders(id) — must go before
      // orders are deleted below, same reasoning as handoff_codes/order_events.
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
      // delivery_legs reference orders too.
      await orderEvents.query(
        `DELETE FROM delivery_legs WHERE "orderId" IN (
           SELECT id FROM orders WHERE "originNodeId" IN (
             SELECT id FROM nodes WHERE name LIKE $1))`,
        [nodeNamePattern],
      );
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

    it('releases the capacity slot on arrival, allowing a delivery past the cap afterward', async () => {
      const { cookie, userId } = await createActiveRider(
        'capacity-release-rider@handoffs.e2e.test',
      );
      const orderIds = [
        await createAvailableOrder(
          'capacity-release-consumer-1@handoffs.e2e.test',
        ),
        await createAvailableOrder(
          'capacity-release-consumer-2@handoffs.e2e.test',
        ),
        await createAvailableOrder(
          'capacity-release-consumer-3@handoffs.e2e.test',
        ),
      ];
      for (const orderId of orderIds) {
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${orderId}/accept`)
          .set('Cookie', [cookie])
          .expect(200);
      }
      const cappedProfile = await riderProfiles.findOneByOrFail({ userId });
      expect(cappedProfile.currentActiveOrderCount).toBe(3);

      // Deliver one of the three all the way to arrival — the rider's part
      // of the job is done, so their slot should free up even though the
      // parcel hasn't been collected yet.
      await pickUp(orderIds[0], cookie);
      await arrive(orderIds[0], cookie);

      const releasedProfile = await riderProfiles.findOneByOrFail({ userId });
      expect(releasedProfile.currentActiveOrderCount).toBe(2);

      const fourthOrderId = await createAvailableOrder(
        'capacity-release-consumer-4@handoffs.e2e.test',
      );
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${fourthOrderId}/accept`)
        .set('Cookie', [cookie])
        .expect(200);

      const finalProfile = await riderProfiles.findOneByOrFail({ userId });
      expect(finalProfile.currentActiveOrderCount).toBe(3);
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

  describe('GET /handoffs/my-orders', () => {
    it('lists an accepted order still awaiting pickup', async () => {
      const { cookie } = await createActiveRider(
        'myorders-assigned-rider@handoffs.e2e.test',
      );
      const orderId = await createAvailableOrder(
        'myorders-assigned-consumer@handoffs.e2e.test',
      );
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/accept`)
        .set('Cookie', [cookie])
        .expect(200);

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-orders')
        .set('Cookie', [cookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string; status: string; originNodeName: string }[];
      };
      const item = data.items.find((row) => row.id === orderId);
      expect(item).toBeDefined();
      expect(item?.status).toBe('rider_assigned');
      expect(item?.originNodeName).toContain('origin');
    });

    it('lists a picked-up order still awaiting arrival', async () => {
      const { cookie } = await createActiveRider(
        'myorders-transit-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'myorders-transit-consumer@handoffs.e2e.test',
        cookie,
      );
      await pickUp(orderId, cookie);

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-orders')
        .set('Cookie', [cookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string; status: string }[];
      };
      const item = data.items.find((row) => row.id === orderId);
      expect(item).toBeDefined();
      expect(item?.status).toBe('in_transit');
    });

    it('keeps listing an order after it moves past in_transit — full history, not just the active queue', async () => {
      const { cookie } = await createActiveRider(
        'myorders-arrived-rider@handoffs.e2e.test',
      );
      const orderId = await createArrivedOrder(
        'myorders-arrived-consumer@handoffs.e2e.test',
        cookie,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-orders')
        .set('Cookie', [cookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string; status: string }[];
      };
      const item = data.items.find((row) => row.id === orderId);
      expect(item).toBeDefined();
      expect(item?.status).toBe('arrived_at_destination');
    });

    it("never lists another rider's order", async () => {
      const { cookie: ownerCookie } = await createActiveRider(
        'myorders-owner-rider@handoffs.e2e.test',
      );
      const { cookie: strangerCookie } = await createActiveRider(
        'myorders-stranger-rider@handoffs.e2e.test',
      );
      const orderId = await createAvailableOrder(
        'myorders-stranger-consumer@handoffs.e2e.test',
      );
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/accept`)
        .set('Cookie', [ownerCookie])
        .expect(200);

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-orders')
        .set('Cookie', [strangerCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string }[];
      };
      expect(data.items.some((row) => row.id === orderId)).toBe(false);
    });

    it('rejects a non-Rider role', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-orders')
        .set('Cookie', [originOperatorCookie])
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-orders')
        .expect(401);
    });
  });

  describe('GET /handoffs/my-node/orders', () => {
    it('lists an order where the operator is the origin, tagged myRole: origin', async () => {
      const operatorCookie = await createNodeOperator(
        'mynode-origin-operator@handoffs.e2e.test',
        originNodeId,
      );
      const { id: orderId } = await createPaidOrder(
        'mynode-origin-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders')
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: {
          id: string;
          myRole: string;
          originNodeName: string;
          destinationNodeName: string;
        }[];
      };
      const item = data.items.find((row) => row.id === orderId);
      expect(item).toBeDefined();
      expect(item?.myRole).toBe('origin');
      expect(item?.originNodeName).toContain('origin');
      expect(item?.destinationNodeName).toContain('destination');
    });

    it('lists an order where the operator is the destination, tagged myRole: destination', async () => {
      const operatorCookie = await createNodeOperator(
        'mynode-dest-operator@handoffs.e2e.test',
        destinationNodeId,
      );
      const { id: orderId } = await createPaidOrder(
        'mynode-dest-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders')
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string; myRole: string }[];
      };
      const item = data.items.find((row) => row.id === orderId);
      expect(item).toBeDefined();
      expect(item?.myRole).toBe('destination');
    });

    it('keeps listing an order regardless of status — full history', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'mynode-history-rider@handoffs.e2e.test',
      );
      const operatorCookie = await createNodeOperator(
        'mynode-history-operator@handoffs.e2e.test',
        originNodeId,
      );
      const orderId = await createAssignedOrder(
        'mynode-history-consumer@handoffs.e2e.test',
        riderCookie,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders')
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string; status: string }[];
      };
      const item = data.items.find((row) => row.id === orderId);
      expect(item).toBeDefined();
      expect(item?.status).toBe('rider_assigned');
    });

    it("never lists another Node's order", async () => {
      const otherNodeId = await createNode('mynode-other');
      const operatorCookie = await createNodeOperator(
        'mynode-other-operator@handoffs.e2e.test',
        otherNodeId,
      );
      const { id: orderId } = await createPaidOrder(
        'mynode-other-consumer@handoffs.e2e.test',
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders')
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string }[];
      };
      expect(data.items.some((row) => row.id === orderId)).toBe(false);
    });

    it('rejects a non-NodeOperator role', async () => {
      const { cookie } = await createActiveRider(
        'mynode-forbidden-rider@handoffs.e2e.test',
      );

      await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders')
        .set('Cookie', [cookie])
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders')
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

  describe('POST /handoffs/orders/:id/intake', () => {
    it('marks the order ready for collection and emails a collection code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'intake-rider@handoffs.e2e.test',
      );
      const orderId = await createArrivedOrder(
        'intake-consumer@handoffs.e2e.test',
        riderCookie,
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/intake`)
        .set('Cookie', [destinationOperatorCookie])
        .expect(200);
      expect((response.body as SuccessBody).data.status).toBe(
        'ready_for_collection',
      );

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.status).toBe('ready_for_collection');

      const code = await extractLatestCollectionCode(receiverEmail);
      expect(code).toMatch(/^\d{6}$/);

      const handoffCode = await handoffCodes.findOneByOrFail({
        orderId,
        type: HandoffCodeType.RECEIVER_COLLECTION,
      });
      expect(handoffCode.requestedByUserId).toBeNull();
    });

    it('is idempotent under a duplicate confirm', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'intake-idempotent-rider@handoffs.e2e.test',
      );
      const orderId = await createArrivedOrder(
        'intake-idempotent-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/intake`)
        .set('Cookie', [destinationOperatorCookie])
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/intake`)
        .set('Cookie', [destinationOperatorCookie])
        .expect(200);

      const eventCount = await orderEvents.countBy({
        orderId,
        type: 'ready_for_collection',
      });
      expect(eventCount).toBe(1);
    });

    it("404s for an order belonging to a different Node's operator", async () => {
      const otherNodeId = await createNode('intake-other');
      const operatorCookie = await createNodeOperator(
        'intake-wrong-operator@handoffs.e2e.test',
        otherNodeId,
      );
      const { cookie: riderCookie } = await createActiveRider(
        'intake-wrong-rider@handoffs.e2e.test',
      );
      const orderId = await createArrivedOrder(
        'intake-wrong-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/intake`)
        .set('Cookie', [operatorCookie])
        .expect(404);
    });

    it('rejects a non-NodeOperator role', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'intake-forbidden-rider@handoffs.e2e.test',
      );
      const orderId = await createArrivedOrder(
        'intake-forbidden-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/intake`)
        .set('Cookie', [riderCookie])
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'intake-unauth-rider@handoffs.e2e.test',
      );
      const orderId = await createArrivedOrder(
        'intake-unauth-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/intake`)
        .expect(401);
    });
  });

  describe('POST /handoffs/orders/:id/collection-code/resend', () => {
    it('issues a new code that supersedes the intake code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'resend-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'resend-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const originalCode = await extractLatestCollectionCode(receiverEmail);

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collection-code/resend`)
        .set('Cookie', [destinationOperatorCookie])
        .expect(200);
      const newCode = await extractLatestCollectionCode(receiverEmail);
      expect(newCode).not.toBe(originalCode);

      // The superseded code no longer works...
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code: originalCode, identityConfirmed: true })
        .expect(401);

      // ...but the freshly resent one does.
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code: newCode, identityConfirmed: true })
        .expect(200);
    });

    it('never returns the raw code in the response body', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'resend-noleak-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'resend-noleak-consumer@handoffs.e2e.test',
        riderCookie,
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collection-code/resend`)
        .set('Cookie', [destinationOperatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data;
      expect(Object.keys(data).sort()).toEqual(['expiresAt']);
    });

    it('rejects resend before intake has run', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'resend-early-rider@handoffs.e2e.test',
      );
      const orderId = await createArrivedOrder(
        'resend-early-consumer@handoffs.e2e.test',
        riderCookie,
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collection-code/resend`)
        .set('Cookie', [destinationOperatorCookie])
        .expect(409);
      expect((response.body as ErrorBody).error.code).toBe(
        'ORDER_NOT_READY_FOR_COLLECTION',
      );
    });

    it("404s for an order belonging to a different Node's operator", async () => {
      const otherNodeId = await createNode('resend-other');
      const operatorCookie = await createNodeOperator(
        'resend-wrong-operator@handoffs.e2e.test',
        otherNodeId,
      );
      const { cookie: riderCookie } = await createActiveRider(
        'resend-wrong-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'resend-wrong-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collection-code/resend`)
        .set('Cookie', [operatorCookie])
        .expect(404);
    });

    it('rejects a non-NodeOperator role', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'resend-forbidden-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'resend-forbidden-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collection-code/resend`)
        .set('Cookie', [riderCookie])
        .expect(403);
    });
  });

  describe('POST /handoffs/orders/:id/collect', () => {
    it('completes collection and records the operator attestation', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const code = await extractLatestCollectionCode(receiverEmail);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code, identityConfirmed: true })
        .expect(200);
      expect((response.body as SuccessBody).data.status).toBe('completed');

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.status).toBe('completed');

      const event = await orderEvents.findOneByOrFail({
        orderId,
        type: 'collected_by_receiver',
      });
      expect(event.payload).toEqual({ identityConfirmed: true });
    });

    // Proxy pickup is a legitimate real-world case (someone other than the
    // named receiver collecting on their behalf) — the attestation is
    // advisory, not a blocking guard, so a false value still completes the
    // order.
    it('completes collection even when identity was not confirmed', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-noconfirm-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-noconfirm-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const code = await extractLatestCollectionCode(receiverEmail);

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code, identityConfirmed: false })
        .expect(200);

      const event = await orderEvents.findOneByOrFail({
        orderId,
        type: 'collected_by_receiver',
      });
      expect(event.payload).toEqual({ identityConfirmed: false });
    });

    it('rejects a wrong code and increments the lockout counter durably', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-wrongcode-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-wrongcode-consumer@handoffs.e2e.test',
        riderCookie,
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code: '000000', identityConfirmed: true })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_HANDOFF_CODE',
      );

      const handoffCode = await handoffCodes.findOneByOrFail({
        orderId,
        type: HandoffCodeType.RECEIVER_COLLECTION,
      });
      expect(handoffCode.failedAttempts).toBe(1);

      const order = await orders.findOneByOrFail({ id: orderId });
      expect(order.status).toBe('ready_for_collection');
    });

    it('locks the code out permanently after 5 wrong attempts, even with the right code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-lockout-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-lockout-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const code = await extractLatestCollectionCode(receiverEmail);

      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${orderId}/collect`)
          .set('Cookie', [destinationOperatorCookie])
          .send({ code: '000000', identityConfirmed: true })
          .expect(401);
      }

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code, identityConfirmed: true })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_HANDOFF_CODE',
      );

      // Recovers via resend, same as the rider-code lockout.
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collection-code/resend`)
        .set('Cookie', [destinationOperatorCookie])
        .expect(200);
      const freshCode = await extractLatestCollectionCode(receiverEmail);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code: freshCode, identityConfirmed: true })
        .expect(200);
    });

    it('is idempotent under a duplicate confirm with the same code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-idempotent-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-idempotent-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const code = await extractLatestCollectionCode(receiverEmail);

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code, identityConfirmed: true })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code, identityConfirmed: true })
        .expect(200);

      const eventCount = await orderEvents.countBy({
        orderId,
        type: 'collected_by_receiver',
      });
      expect(eventCount).toBe(1);
    });

    it('rejects an expired code', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-expired-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-expired-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const code = await extractLatestCollectionCode(receiverEmail);

      await handoffCodes.update(
        { orderId, type: HandoffCodeType.RECEIVER_COLLECTION },
        { expiresAt: new Date(Date.now() - 60_000) },
      );

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code, identityConfirmed: true })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_HANDOFF_CODE',
      );
    });

    it("404s for an order belonging to a different Node's operator", async () => {
      const otherNodeId = await createNode('collect-other');
      const operatorCookie = await createNodeOperator(
        'collect-wrong-operator@handoffs.e2e.test',
        otherNodeId,
      );
      const { cookie: riderCookie } = await createActiveRider(
        'collect-wrong-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-wrong-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const code = await extractLatestCollectionCode(receiverEmail);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [operatorCookie])
        .send({ code, identityConfirmed: true })
        .expect(404);
      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('rejects a non-NodeOperator role', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-forbidden-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-forbidden-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [riderCookie])
        .send({ code: '000000', identityConfirmed: true })
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'collect-unauth-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'collect-unauth-consumer@handoffs.e2e.test',
        riderCookie,
      );

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .send({ code: '000000', identityConfirmed: true })
        .expect(401);
    });
  });

  describe('counter flow: shelf numbers, scan lookup, queues', () => {
    function dropOff(orderId: string): request.Test {
      return request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/drop-off`)
        .set('Cookie', [originOperatorCookie])
        .expect(200);
    }

    it('gives each parcel on a shelf its own number, frees it at pickup, and reuses it', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'shelf-rider@handoffs.e2e.test',
      );
      const a = await createPaidOrder('shelf-a@handoffs.e2e.test');
      const b = await createPaidOrder('shelf-b@handoffs.e2e.test');

      const shelfA = ((await dropOff(a.id)).body as SuccessBody).data
        .shelfNumber as number;
      const shelfB = ((await dropOff(b.id)).body as SuccessBody).data
        .shelfNumber as number;
      expect(shelfA).toBeGreaterThanOrEqual(1);
      expect(shelfB).not.toBe(shelfA);

      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${a.id}/accept`)
        .set('Cookie', [riderCookie])
        .expect(200);
      await pickUp(a.id, riderCookie);
      const pickedUp = await orders.findOneByOrFail({ id: a.id });
      expect(pickedUp.shelfNodeId).toBeNull();
      expect(pickedUp.shelfNumber).toBeNull();

      const c = await createPaidOrder('shelf-c@handoffs.e2e.test');
      const shelfC = ((await dropOff(c.id)).body as SuccessBody).data
        .shelfNumber as number;
      expect(shelfC).toBe(shelfA);
      // Four accounts (password hashing) and three paid orders — slower
      // than Jest's 5 s default on a loaded machine.
    }, 20_000);

    it('shelves the parcel at the destination on intake and frees it on collection', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'shelf-dest-rider@handoffs.e2e.test',
      );
      const orderId = await createReadyForCollectionOrder(
        'shelf-dest@handoffs.e2e.test',
        riderCookie,
      );
      const shelved = await orders.findOneByOrFail({ id: orderId });
      expect(shelved.shelfNodeId).toBe(destinationNodeId);
      expect(shelved.shelfNumber).toBeGreaterThanOrEqual(1);

      const code = await extractLatestCollectionCode(receiverEmail);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${orderId}/collect`)
        .set('Cookie', [destinationOperatorCookie])
        .send({ code, identityConfirmed: true })
        .expect(200);

      const collected = await orders.findOneByOrFail({ id: orderId });
      expect(collected.shelfNodeId).toBeNull();
      expect(collected.shelfNumber).toBeNull();
    });

    it('finds a sloppily typed code at either Node, with the next action for that side', async () => {
      const { cookie: riderCookie } = await createActiveRider(
        'scan-rider@handoffs.e2e.test',
      );
      const orderId = await createAssignedOrder(
        'scan-consumer@handoffs.e2e.test',
        riderCookie,
      );
      const { trackingCode } = await orders.findOneByOrFail({ id: orderId });
      // "LCM-4F2K-9XPT" typed as "4f2k 9xpt".
      const typed = trackingCode.slice(4).replace('-', ' ').toLowerCase();

      const atDestination = (
        (
          await request(app.getHttpServer())
            .get(
              `/api/v1/handoffs/orders/by-tracking-code/${encodeURIComponent(typed)}`,
            )
            .set('Cookie', [destinationOperatorCookie])
            .expect(200)
        ).body as SuccessBody
      ).data;
      expect(atDestination.trackingCode).toBe(trackingCode);
      expect(atDestination.myRole).toBe('destination');
      expect(atDestination.nextAction).toBe('await_arrival');
      expect(atDestination.shelfNumber).toBeNull();
      expect(atDestination.receiverMasked).toBe('R. T. · ***5678');
      expect(JSON.stringify(atDestination)).not.toContain('Receiver Tester');

      const atOrigin = (
        (
          await request(app.getHttpServer())
            .get(
              `/api/v1/handoffs/orders/by-tracking-code/${encodeURIComponent(typed)}`,
            )
            .set('Cookie', [originOperatorCookie])
            .expect(200)
        ).body as SuccessBody
      ).data;
      expect(atOrigin.myRole).toBe('origin');
      expect(atOrigin.nextAction).toBe('hand_to_rider');
      expect(atOrigin.shelfNumber).toEqual(expect.any(Number));
    });

    it('404s for input that cannot be a tracking code', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/handoffs/orders/by-tracking-code/not-a-code')
        .set('Cookie', [originOperatorCookie])
        .expect(404);
    });

    it('filters to a work queue scoped to the side the Node plays', async () => {
      const { id } = await createPaidOrder('queue-consumer@handoffs.e2e.test');
      const ids = async (cookie: string, queue: string) =>
        (
          (
            await request(app.getHttpServer())
              .get(`/api/v1/handoffs/my-node/orders?queue=${queue}&limit=100`)
              .set('Cookie', [cookie])
              .expect(200)
          ).body as SuccessBody
        ).data.items as { id: string; nextAction: string }[];

      const toReceive = await ids(originOperatorCookie, 'to_receive');
      expect(toReceive.find((item) => item.id === id)?.nextAction).toBe(
        'confirm_drop_off',
      );
      expect(
        (await ids(destinationOperatorCookie, 'incoming')).map((i) => i.id),
      ).not.toContain(id);

      await request(app.getHttpServer())
        .get('/api/v1/handoffs/my-node/orders?queue=everything')
        .set('Cookie', [originOperatorCookie])
        .expect(400);
    });
  });

  describe('tracking emails and public tracking', () => {
    async function latestEmail(to: string, subject: string) {
      const event = await outboxEvents
        .createQueryBuilder('o')
        .where('o."eventType" = \'email\'')
        .andWhere("o.payload ->> 'to' = :to", { to })
        .andWhere("o.payload ->> 'subject' = :subject", { subject })
        .orderBy('o."createdAt"', 'DESC')
        .getOneOrFail();
      return event.payload as {
        text: string;
        html: string;
        attachments?: { contentId: string; contentType: string }[];
      };
    }

    function tokenFrom(text: string): string {
      const match = /\/track\/[^?\s]+\?t=([A-Za-z0-9_-]+)/.exec(text);
      if (!match) {
        throw new Error('No tracking link in email');
      }
      return match[1];
    }

    it('sends the sender their tracking code, label instructions, link and QR', async () => {
      const consumerEmail = 'track-sender@handoffs.e2e.test';
      const { trackingCode } = await createPaidOrder(consumerEmail);

      const email = await latestEmail(
        consumerEmail,
        'Your Locoomo order is confirmed',
      );
      expect(email.text).toContain(`Tracking code: ${trackingCode}`);
      expect(email.text).toContain('Write this clearly on the parcel');
      expect(email.text).toContain(`/track/${trackingCode}?t=`);
      expect(email.html).toContain('cid:tracking-qr');
      expect(email.attachments?.[0]).toMatchObject({
        contentId: 'tracking-qr',
        contentType: 'image/png',
      });
    });

    it('tells the receiver a parcel is on its way when it is dropped off', async () => {
      const { id, trackingCode } = await createPaidOrder(
        'track-dropoff@handoffs.e2e.test',
      );
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${id}/drop-off`)
        .set('Cookie', [originOperatorCookie])
        .expect(200);

      const email = await latestEmail(
        receiverEmail,
        'A parcel is on its way to you',
      );
      expect(email.text).toContain(trackingCode);
      expect(email.text).toContain('ready for collection at');
      expect(email.attachments).toHaveLength(1);
    });

    it("gives the sender's order a tracking link and label instructions", async () => {
      const { id, trackingCode, consumerCookie } = await createPaidOrder(
        'track-orders-api@handoffs.e2e.test',
      );

      const data = (
        (
          await request(app.getHttpServer())
            .get(`/api/v1/orders/${id}`)
            .set('Cookie', [consumerCookie])
            .expect(200)
        ).body as SuccessBody
      ).data as {
        trackingUrl: string;
        labelInstructions: { lines: string[] };
      };
      expect(data.trackingUrl).toContain(`/track/${trackingCode}?t=`);
      expect(data.labelInstructions.lines[0]).toBe(trackingCode);
      expect(data.labelInstructions.lines[1]).toMatch(/^TO: /);
    });

    describe('GET /track/:trackingCode', () => {
      let trackingCode: string;
      let token: string;

      beforeAll(async () => {
        const order = await createPaidOrder('track-public@handoffs.e2e.test');
        trackingCode = order.trackingCode;
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${order.id}/drop-off`)
          .set('Cookie', [originOperatorCookie])
          .expect(200);
        token = tokenFrom(
          (await latestEmail(receiverEmail, 'A parcel is on its way to you'))
            .text,
        );
      });

      it('shows status, timeline and destination with the link token — and nothing personal', async () => {
        const data = (
          (
            await request(app.getHttpServer())
              .get(`/api/v1/track/${trackingCode}?t=${token}`)
              .expect(200)
          ).body as SuccessBody
        ).data as {
          status: string;
          isFinal: boolean;
          timeline: { status: string; label: string }[];
          destination: { name: string; openingHours: unknown };
          nextStep: string;
        };

        expect(data.status).toBe('at_origin_station');
        expect(data.isFinal).toBe(false);
        expect(data.timeline.map((entry) => entry.status)).toEqual([
          'order_placed',
          'at_origin_station',
        ]);
        expect(data.destination.name).toContain('destination');
        expect(data.destination.openingHours).toEqual(
          NODE_CONTACT_FIELDS.openingHours,
        );
        expect(data.nextStep).toEqual(expect.any(String));

        const body = JSON.stringify(data);
        for (const secret of [
          'Receiver Tester',
          receiverEmail,
          '8012345678',
          'shelf',
          'amountKobo',
        ]) {
          expect(body).not.toContain(secret);
        }
      });

      it('accepts the last four digits of the receiver phone instead of a token', async () => {
        await request(app.getHttpServer())
          .get(`/api/v1/track/${trackingCode.toLowerCase()}?phoneLast4=5678`)
          .expect(200);
      });

      it('answers every failure with the same 404', async () => {
        const responses = await Promise.all(
          [
            `/api/v1/track/${trackingCode}?t=${token.slice(0, -1)}x`,
            `/api/v1/track/${trackingCode}?phoneLast4=0000`,
            `/api/v1/track/LCM-0000-0000?t=${token}`,
            `/api/v1/track/garbage?phoneLast4=5678`,
          ].map((url) => request(app.getHttpServer()).get(url).expect(404)),
        );
        const messages = new Set(
          responses.map(
            (response) =>
              (response.body as { error: { code: string } }).error.code,
          ),
        );
        expect([...messages]).toEqual(['NOT_FOUND']);
      });

      it('requires exactly one of t or phoneLast4', async () => {
        await request(app.getHttpServer())
          .get(`/api/v1/track/${trackingCode}`)
          .expect(400);
        await request(app.getHttpServer())
          .get(`/api/v1/track/${trackingCode}?t=${token}&phoneLast4=5678`)
          .expect(400);
      });

      it('stops working 30 days after the parcel is collected', async () => {
        const order = await createPaidOrder('track-expired@handoffs.e2e.test');
        await orders.query(
          `UPDATE orders SET status = 'completed', "updatedAt" = now() - interval '31 days'
            WHERE id = $1`,
          [order.id],
        );

        await request(app.getHttpServer())
          .get(`/api/v1/track/${order.trackingCode}?phoneLast4=5678`)
          .expect(404);
      });
    });
  });

  describe('external courier through the logistics layer', () => {
    const courier = new FakeCourierProvider();
    let courierOriginNodeId: string;
    let courierOperatorCookie: string;
    let dataSource: DataSource;
    let legs: Repository<DeliveryLegEntity>;
    let deliveryEvents: DeliveryEventsService;
    let submit: (legId: string) => Promise<void>;

    beforeAll(async () => {
      dataSource = app.get(DataSource);
      legs = dataSource.getRepository(DeliveryLegEntity);
      deliveryEvents = app.get(DeliveryEventsService);
      app.get(LogisticsProviderRegistry).register(courier);
      const handler = app.get(OutboxHandlerRegistry).get('logistics.submit')!;
      submit = (legId) => handler.handle({ legId });

      courierOriginNodeId = await createNode('courier-origin');
      courierOperatorCookie = await createNodeOperator(
        'courier-operator@handoffs.e2e.test',
        courierOriginNodeId,
      );
      // Preferred over in-house riders, but piloted on its own origin Node
      // only — the rest of this suite keeps routing to the in-house pool.
      await dataSource.query(
        `INSERT INTO logistics_providers
           (key, label, enabled, priority, "maxAttempts", "pilotNodeIds")
         VALUES ('fake_courier', 'Fake Courier', true, 10, 1, $1)`,
        [[courierOriginNodeId]],
      );
    });

    afterAll(async () => {
      await dataSource.query(
        `DELETE FROM logistics_inbound_events WHERE "providerKey" = 'fake_courier'`,
      );
      await dataSource.query(
        `DELETE FROM delivery_legs WHERE "providerKey" = 'fake_courier'`,
      );
      await dataSource.query(
        `DELETE FROM logistics_providers WHERE key = 'fake_courier'`,
      );
    });

    async function dropOffWithCourier(email: string) {
      const order = await createPaidOrder(email, courierOriginNodeId);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${order.id}/drop-off`)
        .set('Cookie', [courierOperatorCookie])
        .expect(200);
      const leg = await legs.findOneByOrFail({ orderId: order.id });
      return { ...order, leg };
    }

    // What the courier reports about a delivery — applied the way webhook
    // processing and reconciliation apply it.
    function courierReports(
      externalId: string,
      status: DeliveryLegStatus,
      snapshot: Partial<ProviderDeliverySnapshot> = {},
    ): Promise<boolean> {
      return dataSource.transaction((manager) =>
        deliveryEvents.syncFromSnapshot(
          'fake_courier',
          {
            externalId,
            status,
            providerStatus: status,
            sequence: null,
            courier: null,
            trackingUrl: null,
            actualKobo: null,
            surchargeKobo: null,
            failureReason: null,
            ...snapshot,
          },
          manager,
        ),
      );
    }

    it('routes to the courier at drop-off, submits through the outbox, and keeps the order out of the rider pool', async () => {
      const { id, trackingCode, leg } = await dropOffWithCourier(
        'courier-route@handoffs.e2e.test',
      );
      expect(leg).toMatchObject({
        providerKey: 'fake_courier',
        status: 'requested',
        externalId: null,
      });

      await submit(leg.id);
      const submitted = courier.requests.find((r) => r.legId === leg.id)!;
      expect(submitted.pickup.nodeId).toBe(courierOriginNodeId);
      expect(submitted.dropoff.nodeId).toBe(destinationNodeId);
      expect(submitted.pickup.contactPhone).toBe(
        NODE_CONTACT_FIELDS.contactPhone,
      );
      expect(submitted.description).toContain(trackingCode);
      expect(JSON.stringify(submitted)).not.toContain('Receiver Tester');
      expect(await legs.findOneByOrFail({ id: leg.id })).toMatchObject({
        externalId: `fake-${leg.id}`,
        quotedKobo: 150000,
      });

      const { cookie: riderCookie } = await createActiveRider(
        'courier-pool-rider@handoffs.e2e.test',
      );
      const pool = (
        (
          await request(app.getHttpServer())
            .get(
              `/api/v1/handoffs/available-orders?latitude=${riderLat}&longitude=${riderLng}&limit=100`,
            )
            .set('Cookie', [riderCookie])
            .expect(200)
        ).body as SuccessBody
      ).data.items as { id: string }[];
      expect(pool.map((item) => item.id)).not.toContain(id);
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${id}/accept`)
        .set('Cookie', [riderCookie])
        .expect(409);
    });

    it("moves the order on the courier's events — ignoring stale ones — and shows the courier to each audience", async () => {
      const { id, trackingCode, consumerCookie, leg } =
        await dropOffWithCourier('courier-progress@handoffs.e2e.test');
      await submit(leg.id);
      const externalId = `fake-${leg.id}`;
      const slotsBefore = (
        await nodes.findOneByOrFail({ id: courierOriginNodeId })
      ).currentCount;

      expect(
        await courierReports(externalId, DeliveryLegStatus.ASSIGNED, {
          sequence: 1,
          courier: {
            name: 'Musa A.',
            phone: '+2348031112222',
            vehicle: 'Motorbike',
          },
        }),
      ).toBe(true);
      const assigned = await orders.findOneByOrFail({ id });
      expect(assigned.status).toBe('rider_assigned');
      expect(assigned.riderId).toBeNull();

      const atCounter = (
        (
          await request(app.getHttpServer())
            .get(`/api/v1/handoffs/orders/by-tracking-code/${trackingCode}`)
            .set('Cookie', [courierOperatorCookie])
            .expect(200)
        ).body as SuccessBody
      ).data as {
        nextAction: string;
        delivery: {
          provider: string;
          providerLabel: string;
          handover: string;
          courier: { phone?: string };
        };
      };
      expect(atCounter.nextAction).toBe('hand_to_courier');
      expect(atCounter.delivery).toMatchObject({
        provider: 'fake_courier',
        providerLabel: 'Fake Courier',
        handover: 'give_code_to_courier',
        courier: { name: 'Musa A.', phone: '+2348031112222' },
      });

      const forSender = (
        (
          await request(app.getHttpServer())
            .get(`/api/v1/orders/${id}`)
            .set('Cookie', [consumerCookie])
            .expect(200)
        ).body as SuccessBody
      ).data as { delivery: { courier: Record<string, unknown> } };
      expect(forSender.delivery.courier.name).toBe('Musa A.');
      expect(forSender.delivery.courier).not.toHaveProperty('phone');

      await courierReports(externalId, DeliveryLegStatus.PICKED_UP, {
        sequence: 2,
      });
      const pickedUp = await orders.findOneByOrFail({ id });
      expect(pickedUp.status).toBe('in_transit');
      expect(pickedUp.shelfNumber).toBeNull();
      expect(
        (await nodes.findOneByOrFail({ id: courierOriginNodeId })).currentCount,
      ).toBe(slotsBefore - 1);

      // A late redelivery of an older update changes nothing.
      expect(
        await courierReports(externalId, DeliveryLegStatus.ASSIGNED, {
          sequence: 1,
        }),
      ).toBe(false);
      expect((await orders.findOneByOrFail({ id })).status).toBe('in_transit');

      await courierReports(externalId, DeliveryLegStatus.DELIVERED, {
        sequence: 3,
      });
      expect((await orders.findOneByOrFail({ id })).status).toBe(
        'arrived_at_destination',
      );
      const delivered = await legs.findOneByOrFail({ id: leg.id });
      expect(delivered.status).toBe('delivered');
      expect(delivered.endedAt).toBeInstanceOf(Date);
    });

    it('falls back to the in-house pool when the courier rejects the job', async () => {
      const { id, leg } = await dropOffWithCourier(
        'courier-fallback@handoffs.e2e.test',
      );
      courier.failNext = new LogisticsProviderError(
        'fake_courier',
        'createDelivery',
        'INSUFFICIENT_BALANCE',
        false,
      );

      await submit(leg.id);

      const rejected = await legs.findOneByOrFail({ id: leg.id });
      expect(rejected.status).toBe('cancelled');
      expect(rejected.failureReason).toContain('INSUFFICIENT_BALANCE');
      const fallback = await legs.findOneByOrFail({
        orderId: id,
        status: DeliveryLegStatus.REQUESTED,
      });
      expect(fallback).toMatchObject({
        providerKey: 'in_house',
        attemptNumber: 2,
      });

      const { cookie: riderCookie } = await createActiveRider(
        'courier-fallback-rider@handoffs.e2e.test',
      );
      await request(app.getHttpServer())
        .post(`/api/v1/handoffs/orders/${id}/accept`)
        .set('Cookie', [riderCookie])
        .expect(200);
    });

    it('leaves the leg for the outbox to retry on a transient failure', async () => {
      const { leg } = await dropOffWithCourier(
        'courier-retry@handoffs.e2e.test',
      );
      courier.failNext = new LogisticsProviderError(
        'fake_courier',
        'createDelivery',
        'timed out',
        true,
      );

      await expect(submit(leg.id)).rejects.toThrow('timed out');
      expect(await legs.findOneByOrFail({ id: leg.id })).toMatchObject({
        status: 'requested',
        externalId: null,
      });

      await submit(leg.id);
      expect((await legs.findOneByOrFail({ id: leg.id })).externalId).toBe(
        `fake-${leg.id}`,
      );
    });

    describe('phase 3: webhooks, releases, timeouts, handovers, settlement', () => {
      let processInbound: (inboundEventId: string) => Promise<void>;
      let reconciler: DeliveryReconcilerService;

      beforeAll(async () => {
        const handler = app
          .get(OutboxHandlerRegistry)
          .get('logistics.process_inbound')!;
        processInbound = (inboundEventId) => handler.handle({ inboundEventId });
        reconciler = app.get(DeliveryReconcilerService);
        await dataSource.query(
          `UPDATE logistics_providers SET "assignTimeoutMinutes" = 20 WHERE key = 'fake_courier'`,
        );
      });

      async function submittedCourierOrder(email: string) {
        const order = await dropOffWithCourier(email);
        await submit(order.leg.id);
        return { ...order, externalId: `fake-${order.leg.id}` };
      }

      function postWebhook(body: Record<string, unknown>, signature = 'valid') {
        return request(app.getHttpServer())
          .post('/api/v1/logistics/webhooks/fake_courier')
          .set('x-fake-signature', signature)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify(body));
      }

      it('stores a signed webhook once, then applies what the courier says now', async () => {
        const { id, externalId } = await submittedCourierOrder(
          'courier-webhook@handoffs.e2e.test',
        );
        // The courier has moved on to picked_up; the webhook only says
        // "assigned" — processing must apply the courier's current state.
        courier.advance(externalId, DeliveryLegStatus.ASSIGNED);
        courier.advance(externalId, DeliveryLegStatus.PICKED_UP);
        const body = {
          id: `wh-${externalId}`,
          externalId,
          event: DeliveryEventType.ASSIGNED,
        };

        await postWebhook(body).expect(200);
        await postWebhook(body).expect(200); // redelivery
        const stored = await dataSource.query<{ id: string }[]>(
          `SELECT id FROM logistics_inbound_events WHERE "eventId" = $1`,
          [body.id],
        );
        expect(stored).toHaveLength(1);

        await processInbound(stored[0].id);
        expect((await orders.findOneByOrFail({ id })).status).toBe(
          'in_transit',
        );
        const [processed] = await dataSource.query<{ processedAt: Date }[]>(
          `SELECT "processedAt" FROM logistics_inbound_events WHERE id = $1`,
          [stored[0].id],
        );
        expect(processed.processedAt).toBeInstanceOf(Date);
      });

      it('rejects an unsigned webhook and one for an unknown courier', async () => {
        await postWebhook(
          { id: 'wh-x', externalId: 'x', event: 'assigned' },
          'forged',
        ).expect(401);
        await request(app.getHttpServer())
          .post('/api/v1/logistics/webhooks/no_such_courier')
          .set('Content-Type', 'application/json')
          .send('{}')
          .expect(404);
      });

      it('puts the order back to waiting when the courier drops the job before pickup', async () => {
        const { id, externalId, leg } = await submittedCourierOrder(
          'courier-release@handoffs.e2e.test',
        );
        courier.advance(externalId, DeliveryLegStatus.ASSIGNED);
        await courierReports(externalId, DeliveryLegStatus.ASSIGNED, {
          sequence: 2,
        });
        expect((await orders.findOneByOrFail({ id })).status).toBe(
          'rider_assigned',
        );

        await courierReports(externalId, DeliveryLegStatus.REQUESTED, {
          sequence: 3,
        });
        expect((await orders.findOneByOrFail({ id })).status).toBe(
          'parcel_received_at_origin',
        );
        const released = await legs.findOneByOrFail({ id: leg.id });
        expect(released.status).toBe('requested');
        expect(released.courierName).toBeNull();
        expect(
          await orderEvents.countBy({ orderId: id, type: 'courier_released' }),
        ).toBe(1);
      });

      it('re-routes to the in-house pool when the courier cancels (no rider found)', async () => {
        const { id, externalId, leg } = await submittedCourierOrder(
          'courier-cancel@handoffs.e2e.test',
        );
        await courierReports(externalId, DeliveryLegStatus.ASSIGNED, {
          sequence: 2,
        });
        await courierReports(externalId, DeliveryLegStatus.CANCELLED, {
          sequence: 3,
          failureReason: 'no_rider_found',
        });

        expect((await orders.findOneByOrFail({ id })).status).toBe(
          'parcel_received_at_origin',
        );
        expect(await legs.findOneByOrFail({ id: leg.id })).toMatchObject({
          status: 'cancelled',
          failureReason: 'no_rider_found',
        });
        // fake_courier allows one attempt per order — next is in-house.
        expect(
          await legs.findOneByOrFail({
            orderId: id,
            status: DeliveryLegStatus.REQUESTED,
          }),
        ).toMatchObject({ providerKey: 'in_house' });
      });

      it('gives up on a courier that finds no rider in time, and polls deliveries that went quiet', async () => {
        const waiting = await submittedCourierOrder(
          'courier-timeout@handoffs.e2e.test',
        );
        await legs.query(
          `UPDATE delivery_legs SET "createdAt" = now() - interval '30 minutes' WHERE id = $1`,
          [waiting.leg.id],
        );
        const quiet = await submittedCourierOrder(
          'courier-quiet@handoffs.e2e.test',
        );
        await courierReports(quiet.externalId, DeliveryLegStatus.ASSIGNED, {
          sequence: 2,
        });
        courier.advance(quiet.externalId, DeliveryLegStatus.ASSIGNED);
        courier.advance(quiet.externalId, DeliveryLegStatus.PICKED_UP);
        await legs.query(
          `UPDATE delivery_legs SET "updatedAt" = now() - interval '10 minutes' WHERE id = $1`,
          [quiet.leg.id],
        );

        await reconciler.runOnce();

        expect(courier.cancelled).toContain(waiting.externalId);
        expect(
          await legs.findOneByOrFail({ id: waiting.leg.id }),
        ).toMatchObject({
          status: 'cancelled',
          failureReason: 'assign_timeout',
        });
        expect(
          await legs.findOneByOrFail({
            orderId: waiting.id,
            status: DeliveryLegStatus.REQUESTED,
          }),
        ).toMatchObject({ providerKey: 'in_house' });
        expect((await orders.findOneByOrFail({ id: quiet.id })).status).toBe(
          'in_transit',
        );
      });

      it('gives Node staff the right live code for each side of the handover', async () => {
        const { id, externalId } = await submittedCourierOrder(
          'courier-codes@handoffs.e2e.test',
        );
        const handover = (cookie: string) =>
          request(app.getHttpServer())
            .get(`/api/v1/handoffs/orders/${id}/courier-handover`)
            .set('Cookie', [cookie]);

        // No courier yet.
        await handover(courierOperatorCookie).expect(409);

        courier.advance(externalId, DeliveryLegStatus.ASSIGNED);
        await courierReports(externalId, DeliveryLegStatus.ASSIGNED, {
          sequence: 2,
          courier: {
            name: 'Musa A.',
            phone: '+2348031112222',
            vehicle: 'motorbike',
          },
        });
        const pickup = await handover(courierOperatorCookie).expect(200);
        expect(pickup.headers['cache-control']).toBe('no-store');
        expect((pickup.body as SuccessBody).data).toMatchObject({
          kind: 'pickup',
          code: '111111',
          providerLabel: 'Fake Courier',
          courier: { name: 'Musa A.' },
        });
        // The destination has nothing to give until the parcel is on its way.
        await handover(destinationOperatorCookie).expect(409);

        courier.advance(externalId, DeliveryLegStatus.PICKED_UP);
        await courierReports(externalId, DeliveryLegStatus.PICKED_UP, {
          sequence: 3,
        });
        const delivery = await handover(destinationOperatorCookie).expect(200);
        expect((delivery.body as SuccessBody).data).toMatchObject({
          kind: 'delivery',
          code: '222222',
        });

        courier.failCodes = true;
        const failed = await handover(destinationOperatorCookie).expect(502);
        courier.failCodes = false;
        expect((failed.body as { error: { code: string } }).error.code).toBe(
          'LOGISTICS_PROVIDER_ERROR',
        );
      });

      it('settles a courier-delivered order with a non-payable courier allocation instead of a rider share', async () => {
        const { id, externalId } = await submittedCourierOrder(
          'courier-settle@handoffs.e2e.test',
        );
        await courierReports(externalId, DeliveryLegStatus.DELIVERED, {
          sequence: 9,
        });
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${id}/intake`)
          .set('Cookie', [destinationOperatorCookie])
          .expect(200);
        const code = await extractLatestCollectionCode(receiverEmail);
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${id}/collect`)
          .set('Cookie', [destinationOperatorCookie])
          .send({ code, identityConfirmed: true })
          .expect(200);

        const entries = await revenueSplitEntries.findBy({ orderId: id });
        expect(entries.map((e) => e.partyType).sort()).toEqual([
          'courier_allocation',
          'destination_node',
          'node',
          'platform',
        ]);
        const allocation = entries.find(
          (e) => (e.partyType as string) === 'courier_allocation',
        )!;
        expect(allocation.partyId).toBeNull();
        expect(allocation.payoutStatus).toBe('not_payable');

        const refused = await request(app.getHttpServer())
          .patch(
            `/api/v1/admin/revenue-split/entries/${allocation.id}/mark-paid`,
          )
          .set('Cookie', [adminCookie])
          .expect(409);
        expect((refused.body as { error: { code: string } }).error.code).toBe(
          'REVENUE_SPLIT_NOT_PAYABLE',
        );
      });

      it('brings a failed delivery back to the origin station for the sender to collect', async () => {
        const senderEmail = 'courier-return@handoffs.e2e.test';
        const { id, trackingCode, externalId, leg } =
          await submittedCourierOrder(senderEmail);
        await courierReports(externalId, DeliveryLegStatus.PICKED_UP, {
          sequence: 2,
        });
        const slotsAfterPickup = (
          await nodes.findOneByOrFail({ id: courierOriginNodeId })
        ).currentCount;

        // The courier gives up on the destination and heads back.
        courier.advance(externalId, DeliveryLegStatus.RETURNING);
        await courierReports(externalId, DeliveryLegStatus.RETURNING, {
          sequence: 3,
        });
        expect((await orders.findOneByOrFail({ id })).status).toBe(
          'return_in_transit',
        );
        expect(
          (await orderEvents.findBy({ orderId: id })).map((e) => e.type),
        ).toEqual(
          expect.arrayContaining(['return_initiated', 'return_in_transit']),
        );
        const emails = await outboxEvents
          .createQueryBuilder('o')
          .where("o.payload ->> 'subject' IN (:...subjects)", {
            subjects: [
              'Your parcel is being returned',
              'Your parcel could not be delivered',
            ],
          })
          .andWhere("o.payload ->> 'text' LIKE :code", {
            code: `%${trackingCode}%`,
          })
          .getMany();
        expect(emails.map((e) => e.payload.to).sort()).toEqual(
          [receiverEmail, senderEmail].sort(),
        );

        // The origin station reads the returning courier its code.
        const scan = (
          (
            await request(app.getHttpServer())
              .get(`/api/v1/handoffs/orders/by-tracking-code/${trackingCode}`)
              .set('Cookie', [courierOperatorCookie])
              .expect(200)
          ).body as SuccessBody
        ).data;
        expect(scan).toMatchObject({
          myRole: 'origin',
          nextAction: 'receive_from_courier',
        });
        const handover = (
          (
            await request(app.getHttpServer())
              .get(`/api/v1/handoffs/orders/${id}/courier-handover`)
              .set('Cookie', [courierOperatorCookie])
              .expect(200)
          ).body as SuccessBody
        ).data;
        expect(handover).toMatchObject({
          kind: 'return_delivery',
          code: '222222',
        });

        const publicView = (
          (
            await request(app.getHttpServer())
              .get(`/api/v1/track/${trackingCode}?phoneLast4=5678`)
              .expect(200)
          ).body as SuccessBody
        ).data as {
          status: string;
          courierLabel: string;
          origin: { address?: string };
        };
        expect(publicView.status).toBe('returning_to_sender');
        expect(publicView.courierLabel).toBe('Fake Courier');
        expect(publicView.origin.address).toBeDefined();

        // Back at the origin counter: it takes a slot again.
        courier.advance(externalId, DeliveryLegStatus.RETURNED);
        await courierReports(externalId, DeliveryLegStatus.RETURNED, {
          sequence: 4,
        });
        expect((await orders.findOneByOrFail({ id })).status).toBe(
          'returned_to_origin',
        );
        expect((await legs.findOneByOrFail({ id: leg.id })).status).toBe(
          'returned',
        );
        expect(
          (await nodes.findOneByOrFail({ id: courierOriginNodeId }))
            .currentCount,
        ).toBe(slotsAfterPickup + 1);

        // Only the origin may shelve it; the destination gets a 404.
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${id}/return-intake`)
          .set('Cookie', [destinationOperatorCookie])
          .expect(404);
        const intake = (
          (
            await request(app.getHttpServer())
              .post(`/api/v1/handoffs/orders/${id}/return-intake`)
              .set('Cookie', [courierOperatorCookie])
              .expect(200)
          ).body as SuccessBody
        ).data;
        expect(intake).toMatchObject({
          status: 'ready_for_sender_collection',
          shelfNumber: expect.any(Number) as number,
        });

        // The sender's code is emailed to the sender; a resend replaces it.
        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${id}/collection-code/resend`)
          .set('Cookie', [courierOperatorCookie])
          .expect(200);
        const code = await extractLatestCollectionCode(senderEmail);

        await request(app.getHttpServer())
          .post(`/api/v1/handoffs/orders/${id}/return-collect`)
          .set('Cookie', [courierOperatorCookie])
          .send({
            code: code === '000000' ? '111111' : '000000',
            identityConfirmed: true,
          })
          .expect(401);
        const collected = (
          (
            await request(app.getHttpServer())
              .post(`/api/v1/handoffs/orders/${id}/return-collect`)
              .set('Cookie', [courierOperatorCookie])
              .send({ code, identityConfirmed: true })
              .expect(200)
          ).body as SuccessBody
        ).data;
        expect(collected).toMatchObject({
          status: 'return_completed',
          shelfNumber: null,
        });
        expect(
          (await nodes.findOneByOrFail({ id: courierOriginNodeId }))
            .currentCount,
        ).toBe(slotsAfterPickup);
        // Never delivered, so nothing to split.
        expect(await revenueSplitEntries.countBy({ orderId: id })).toBe(0);

        const finalView = (
          (
            await request(app.getHttpServer())
              .get(`/api/v1/track/${trackingCode}?phoneLast4=5678`)
              .expect(200)
          ).body as SuccessBody
        ).data;
        expect(finalView).toMatchObject({
          status: 'return_completed',
          isFinal: true,
        });
      }, 20_000);
    });
  });
});
