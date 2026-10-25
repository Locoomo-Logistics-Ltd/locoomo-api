import {
  DeliveryEventType,
  DeliveryLegStatus,
  VehicleClass,
} from '../delivery-leg';

// The contract every courier — in-house riders included — implements. The
// rest of the system only ever talks to couriers through this, so adding
// one is: an adapter implementing this port, registered with
// LogisticsProviderRegistry, plus a logistics_providers row to route to it.
// Adapters return these normalised shapes, never a provider's raw response,
// and convert money to integer kobo.

// What the courier physically needs to do the job. Pickup/drop-off are
// Nodes (staffed counters), so the "recipient" is the destination Node's
// counter, never the end receiver — the receiver's personal data doesn't
// leave Locoomo.
export interface DeliveryStop {
  nodeId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  contactName: string;
  contactPhone: string | null; // E.164
}

export interface CreateDeliveryRequest {
  // Stable per leg — adapters pass it as the provider's idempotency key /
  // external reference, so a retried submission can't create a second job.
  legId: string;
  trackingCode: string;
  pickup: DeliveryStop;
  dropoff: DeliveryStop;
  vehicleClass: VehicleClass | null;
  description: string;
  // The most this delivery may cost, from the provider's maxCostShare of
  // the order's delivery fee. A quote above it is a non-retryable refusal
  // (the order then goes to the next courier). Absent = no cap.
  maxCostKobo?: number;
  // Prepaid-wallet providers only: the quoted fees of this provider's other
  // deliveries still in progress, so the adapter can keep headroom for the
  // surcharges they may still incur before committing a new one.
  otherActiveQuotedKobo?: number;
}

export interface CreateDeliveryResult {
  externalId: string | null;
  status: DeliveryLegStatus;
  providerStatus: string | null;
  quotedKobo: number | null;
  trackingUrl: string | null;
  etaMinutes: number | null;
  // Road distance the provider measured, if it reports one — cached per
  // Node pair for pricing.
  distanceMeters: number | null;
}

export interface CourierDetails {
  name: string | null;
  phone: string | null; // E.164
  vehicle: string | null;
}

// A provider's view of one delivery, normalised — what reconciliation and
// webhook processing compare against the stored leg.
export interface ProviderDeliverySnapshot {
  externalId: string;
  status: DeliveryLegStatus;
  providerStatus: string;
  // Monotonic per delivery when the provider has one (Sendii's `sequence`);
  // used to drop stale, out-of-order updates.
  sequence: number | null;
  courier: CourierDetails | null;
  trackingUrl: string | null;
  actualKobo: number | null;
  surchargeKobo: number | null;
  failureReason: string | null;
}

// One inbound webhook, normalised.
export interface ProviderWebhookEvent {
  // Provider's unique id for this delivery attempt of the webhook — dedupe key.
  eventId: string;
  externalId: string | null;
  // null for events with no delivery meaning (pings).
  event: DeliveryEventType | null;
  snapshot: ProviderDeliverySnapshot | null;
}

// Codes a Node operator reads out to an external courier at a handover.
// Live from the provider, never stored — treat as credentials.
export interface HandoverCodes {
  pickupCode: string | null;
  deliveryCode: string | null;
}

export interface ProviderCapabilities {
  vehicleClasses: readonly VehicleClass[];
  // How the custody handover at a counter is proven:
  // 'locoomo_code' — the courier shows a Locoomo code, staff enter it;
  // 'provider_code' — staff read the provider's code to the courier, who
  //   enters it in their own app.
  handover: 'locoomo_code' | 'provider_code';
  // How progress reaches us: 'internal' (our own endpoints, in-house
  // riders), 'webhook' (plus reconciliation polling), or 'polling' only.
  updates: 'internal' | 'webhook' | 'polling';
  // Whether createDelivery calls out to a remote API (then dispatch runs
  // through the outbox, outside the drop-off transaction) or is purely local.
  remoteSubmission: boolean;
  // Latest leg status from which the provider still accepts a cancellation.
  cancellableUntil: DeliveryLegStatus.REQUESTED | DeliveryLegStatus.ASSIGNED;
  // Prepaid wallet that must cover the fee before dispatch.
  prepaidWallet: boolean;
  // Prepaid wallets only: the most surcharges can add to a delivery, as a
  // share of its fee — the headroom kept for in-flight deliveries.
  surchargeHeadroomFactor?: number;
  // measureRoute providers: minimum gap between calls to stay inside the
  // provider's rate limit (Sendii: 30 quotes/min).
  measureRoutePacingMs?: number;
}

export interface LogisticsProvider {
  readonly key: string;
  readonly capabilities: ProviderCapabilities;

  createDelivery(request: CreateDeliveryRequest): Promise<CreateDeliveryResult>;

  // Idempotent: cancelling an already-cancelled delivery succeeds.
  cancel(externalId: string | null): Promise<void>;

  // Remote providers only (updates !== 'internal').
  getDelivery?(externalId: string): Promise<ProviderDeliverySnapshot>;
  getHandoverCodes?(externalId: string): Promise<HandoverCodes>;
  verifyWebhook?(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean;
  parseWebhook?(rawBody: Buffer): ProviderWebhookEvent;
  getBalanceKobo?(): Promise<WalletBalance>;
  // Road distance between two points as the provider would drive it, without
  // booking anything (Sendii: a free quote). null when the provider won't
  // serve the trip (out of range) — not an error.
  measureRoute?(
    from: RoutePoint,
    to: RoutePoint,
  ): Promise<{ distanceMeters: number } | null>;
}

export interface RoutePoint {
  latitude: number;
  longitude: number;
  address: string;
  city: string;
}

export interface WalletBalance {
  // What new deliveries can use (balance minus held fees).
  availableKobo: number;
  balanceKobo: number;
  heldKobo: number;
}

export class LogisticsProviderError extends Error {
  constructor(
    readonly providerKey: string,
    readonly operation: string,
    detail: string,
    // false = retrying the same call won't help (rejected request, no
    // balance, service disabled) — move on to the next provider instead.
    readonly retryable: boolean,
    // Road distance the provider measured before refusing (e.g. a quote
    // above the cost cap) — still worth keeping for pricing.
    readonly measuredDistanceMeters?: number,
  ) {
    super(`${providerKey} ${operation} failed: ${detail}`);
    this.name = 'LogisticsProviderError';
  }
}
