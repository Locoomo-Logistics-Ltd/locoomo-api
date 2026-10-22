import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Env } from '../../../../config/env.validation';
import { LogisticsProviderRegistry } from '../../application/logistics-provider.registry';
import {
  DeliveryEventType,
  DeliveryLegStatus,
  VehicleClass,
} from '../../domain/delivery-leg';
import {
  CreateDeliveryRequest,
  CreateDeliveryResult,
  HandoverCodes,
  LogisticsProvider,
  LogisticsProviderError,
  ProviderCapabilities,
  ProviderDeliverySnapshot,
  ProviderWebhookEvent,
} from '../../domain/ports/logistics-provider.port';
import type {
  SendiiDelivery,
  SendiiQuote,
  SendiiStatus,
  SendiiVehicle,
  SendiiWallet,
  SendiiWebhookEvent,
} from './sendii-api.types';
import {
  nairaToKobo,
  SENDII_KEY,
  SENDII_READ_POLICY,
  SENDII_WRITE_POLICY,
  sendiiRequest,
} from './sendii-http';

const STATUS: Record<SendiiStatus, DeliveryLegStatus> = {
  pending: DeliveryLegStatus.REQUESTED,
  assigned: DeliveryLegStatus.ASSIGNED,
  picked_up: DeliveryLegStatus.PICKED_UP,
  delivered: DeliveryLegStatus.DELIVERED,
  returning: DeliveryLegStatus.RETURNING,
  returned: DeliveryLegStatus.RETURNED,
  cancelled: DeliveryLegStatus.CANCELLED,
};

const EVENTS: Record<string, DeliveryEventType> = {
  'delivery.assigned': DeliveryEventType.ASSIGNED,
  'delivery.rider_released': DeliveryEventType.RELEASED,
  'delivery.picked_up': DeliveryEventType.PICKED_UP,
  'delivery.attempt_failed': DeliveryEventType.ATTEMPT_FAILED,
  'delivery.delivered': DeliveryEventType.DELIVERED,
  'delivery.returning': DeliveryEventType.RETURNING,
  'delivery.returned': DeliveryEventType.RETURNED,
  'delivery.cancelled': DeliveryEventType.CANCELLED,
};

const VEHICLES: Partial<Record<VehicleClass, SendiiVehicle>> = {
  [VehicleClass.BICYCLE]: 'bicycle',
  [VehicleClass.MOTORBIKE]: 'motorbike',
  [VehicleClass.CAR]: 'car',
};

// Each extra drop-off attempt and the return leg add 20% of the fee, billed
// after the held fee — at most two redeliveries plus a return. Kept as
// headroom in the wallet so surcharges can't push it negative.
const MAX_SURCHARGE_FACTOR = 0.6;

const ADDRESS_MAX = 200;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

// Sendii Partner API v1 (https://developers.sendii.ng). Registered only when
// SENDII_API_KEY is set (and never under NODE_ENV=test); whether orders are
// actually routed here is the logistics_providers 'sendii' row's call.
@Injectable()
export class SendiiProvider implements LogisticsProvider, OnModuleInit {
  readonly key = SENDII_KEY;
  readonly capabilities: ProviderCapabilities = {
    vehicleClasses: [
      VehicleClass.BICYCLE,
      VehicleClass.MOTORBIKE,
      VehicleClass.CAR,
    ],
    handover: 'provider_code',
    updates: 'webhook',
    remoteSubmission: true,
    cancellableUntil: DeliveryLegStatus.REQUESTED,
    prepaidWallet: true,
  };
  private readonly logger = new Logger(SendiiProvider.name);

  constructor(
    private readonly registry: LogisticsProviderRegistry,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (this.configService.get('NODE_ENV', { infer: true }) === 'test') {
      return;
    }
    if (!this.configService.get('SENDII_API_KEY', { infer: true })) {
      return;
    }
    if (!this.configService.get('SENDII_WEBHOOK_SECRET', { infer: true })) {
      this.logger.warn(
        'SENDII_WEBHOOK_SECRET is not set — Sendii webhooks will be rejected; ' +
          'progress will only arrive through reconciliation polling',
      );
    }
    this.registry.register(this);
  }

  async createDelivery(
    request: CreateDeliveryRequest,
  ): Promise<CreateDeliveryResult> {
    const vehicle = VEHICLES[request.vehicleClass ?? VehicleClass.MOTORBIKE];
    if (!vehicle) {
      throw new LogisticsProviderError(
        this.key,
        'createDelivery',
        `vehicle class ${request.vehicleClass} not offered`,
        false,
      );
    }
    if (!request.dropoff.contactPhone) {
      throw new LogisticsProviderError(
        this.key,
        'createDelivery',
        `destination station ${request.dropoff.nodeId} has no contact phone`,
        false,
      );
    }

    const quote = await this.call<SendiiQuote>('quote', '/quote', {
      query: {
        pickup_lat: request.pickup.latitude,
        pickup_lng: request.pickup.longitude,
        pickup_address: this.addressOf(request.pickup),
        dropoff_lat: request.dropoff.latitude,
        dropoff_lng: request.dropoff.longitude,
        dropoff_address: this.addressOf(request.dropoff),
        vehicle_type: vehicle,
      },
      policy: SENDII_READ_POLICY,
    });
    const feeKobo = nairaToKobo(quote.fee);

    if (request.otherActiveQuotedKobo !== undefined) {
      await this.assertWalletHeadroom(feeKobo, request.otherActiveQuotedKobo);
    }

    const { status, envelope } = await sendiiRequest<SendiiDelivery>(
      'createDelivery',
      '/deliveries',
      {
        ...this.auth(),
        method: 'POST',
        body: {
          quote_id: quote.quote_id,
          // Sendii treats this as the idempotency key: a replay while the
          // delivery is active answers 409 with the existing delivery.
          external_ref: request.legId,
          description: request.description.slice(0, DESCRIPTION_MAX),
          recipient_name: request.dropoff.contactName.slice(0, NAME_MAX),
          recipient_phone: request.dropoff.contactPhone,
          ...(request.pickup.contactPhone
            ? {
                pickup_contact_name: request.pickup.contactName.slice(
                  0,
                  NAME_MAX,
                ),
                pickup_contact_phone: request.pickup.contactPhone,
              }
            : {}),
        },
        policy: SENDII_WRITE_POLICY,
      },
    );
    const delivery = envelope.data;
    if (!delivery) {
      throw new LogisticsProviderError(
        this.key,
        'createDelivery',
        `HTTP ${status} with no delivery in the response`,
        status === 409,
      );
    }

    return {
      externalId: delivery.id,
      status: STATUS[delivery.status],
      providerStatus: delivery.status,
      quotedKobo: nairaToKobo(delivery.fee),
      trackingUrl: delivery.tracking_url,
      etaMinutes: quote.eta_minutes,
    };
  }

  // Cancelling an already-cancelled delivery succeeds at Sendii; a
  // delivery past pickup can't be cancelled (409) — reported as a
  // non-retryable error.
  async cancel(externalId: string | null): Promise<void> {
    if (!externalId) {
      return;
    }
    const { status } = await sendiiRequest<SendiiDelivery>(
      'cancel',
      `/deliveries/${encodeURIComponent(externalId)}`,
      { ...this.auth(), method: 'DELETE', policy: SENDII_WRITE_POLICY },
    );
    if (status === 409) {
      throw new LogisticsProviderError(
        this.key,
        'cancel',
        'delivery can no longer be cancelled',
        false,
      );
    }
  }

  async getDelivery(externalId: string): Promise<ProviderDeliverySnapshot> {
    const delivery = await this.call<SendiiDelivery>(
      'getDelivery',
      `/deliveries/${encodeURIComponent(externalId)}`,
      { policy: SENDII_READ_POLICY },
    );
    return this.toSnapshot(delivery);
  }

  // Fetched live for the Node screen — never stored or logged. pickup_code
  // exists only while assigned, delivery_code only while picked up/returning.
  async getHandoverCodes(externalId: string): Promise<HandoverCodes> {
    const delivery = await this.call<SendiiDelivery>(
      'getHandoverCodes',
      `/deliveries/${encodeURIComponent(externalId)}`,
      { policy: SENDII_READ_POLICY },
    );
    return {
      pickupCode: delivery.pickup_code,
      deliveryCode: delivery.delivery_code,
    };
  }

  async getBalanceKobo(): Promise<{ availableKobo: number }> {
    const wallet = await this.call<SendiiWallet>('getWallet', '/wallet', {
      policy: SENDII_READ_POLICY,
    });
    return { availableKobo: nairaToKobo(wallet.available) };
  }

  // HMAC-SHA512 of the raw body, keyed with the endpoint's whsec_ secret,
  // lowercase hex in X-Sendii-Signature (same scheme as Paystack).
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const secret = this.configService.get('SENDII_WEBHOOK_SECRET', {
      infer: true,
    });
    const signature = headers['x-sendii-signature'];
    if (!secret || !signature) {
      return false;
    }
    const expected = Buffer.from(
      createHmac('sha512', secret).update(rawBody).digest('hex'),
    );
    const actual = Buffer.from(signature);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  parseWebhook(rawBody: Buffer): ProviderWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8')) as SendiiWebhookEvent;
    const event = EVENTS[payload.event] ?? null;
    const delivery = event && 'id' in payload.data ? payload.data : null;
    return {
      eventId: payload.webhook_id,
      externalId: delivery?.id ?? null,
      event,
      snapshot: delivery ? this.toSnapshot(delivery) : null,
    };
  }

  private toSnapshot(delivery: SendiiDelivery): ProviderDeliverySnapshot {
    const settled =
      delivery.status === 'delivered' || delivery.status === 'returned';
    return {
      externalId: delivery.id,
      status: STATUS[delivery.status],
      providerStatus: delivery.status,
      sequence: delivery.sequence,
      courier: delivery.rider
        ? {
            name: delivery.rider.name,
            phone: delivery.rider.phone,
            vehicle: delivery.rider.vehicle,
          }
        : null,
      trackingUrl: delivery.tracking_url,
      // The fee is charged only when the delivery settles.
      actualKobo: settled ? nairaToKobo(delivery.fee) : null,
      surchargeKobo: nairaToKobo(delivery.surcharge),
      failureReason: delivery.cancel_reason,
    };
  }

  private async assertWalletHeadroom(
    feeKobo: number,
    otherActiveQuotedKobo: number,
  ): Promise<void> {
    const { availableKobo } = await this.getBalanceKobo();
    // `available` already excludes held fees; what it doesn't cover is the
    // surcharges in-flight deliveries (and this one) may still add.
    const neededKobo = Math.ceil(
      feeKobo * (1 + MAX_SURCHARGE_FACTOR) +
        otherActiveQuotedKobo * MAX_SURCHARGE_FACTOR,
    );
    if (availableKobo < neededKobo) {
      this.logger.error(
        `Sendii wallet too low: ₦${availableKobo / 100} available, ₦${neededKobo / 100} needed — falling back`,
      );
      throw new LogisticsProviderError(
        this.key,
        'createDelivery',
        `INSUFFICIENT_WALLET_HEADROOM: available ${availableKobo} kobo, needed ${neededKobo} kobo`,
        false,
      );
    }
  }

  private addressOf(stop: { name: string; address: string; city: string }) {
    return `${stop.address}, ${stop.city}`.slice(0, ADDRESS_MAX);
  }

  private async call<T>(
    operation: string,
    path: string,
    options: {
      query?: Record<string, string | number>;
      policy: typeof SENDII_READ_POLICY;
    },
  ): Promise<T> {
    const { envelope } = await sendiiRequest<T>(operation, path, {
      ...this.auth(),
      ...options,
    });
    if (!envelope.success || envelope.data === undefined) {
      throw new LogisticsProviderError(
        this.key,
        operation,
        'unexpected response',
        false,
      );
    }
    return envelope.data;
  }

  private auth(): { baseUrl: string; apiKey: string } {
    return {
      baseUrl: this.configService.get('SENDII_BASE_URL', { infer: true }),
      apiKey: this.configService.get('SENDII_API_KEY', { infer: true }) ?? '',
    };
  }
}
