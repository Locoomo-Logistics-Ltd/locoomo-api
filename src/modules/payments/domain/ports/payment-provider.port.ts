// Port every concrete payment provider adapter implements (PaystackPaymentProvider
// today). Every method returns *our* normalized shapes, never a provider's raw
// response — translating that shape is the adapter's whole job, so switching
// providers later means writing a new adapter class, not touching anything
// that calls this interface. `refund` is included now even though nothing
// calls it yet (no cancellation flow exists until `orders` grows one) —
// designing it in from the start means a future adapter is written against
// the complete contract once, not patched later.
export interface PaymentInitializeParams {
  // Our own PaymentIntent id, handed to the provider as its transaction
  // reference — Paystack accepts a caller-supplied reference, so verify/
  // webhook lookups never need a separate provider-generated id to track.
  reference: string;
  amountKobo: number;
  email: string;
  callbackUrl: string;
  // Non-PII identifiers only — this is handed to a third-party processor,
  // so receiver/consumer name/email/phone deliberately stay out of it
  // (NDPA); Node names are fine, a Node is a business location, not a
  // person. Gives support/ops a transaction's order context from the
  // provider's own dashboard without a DB lookup.
  metadata: {
    consumerId: string;
    originNodeId: string;
    originNodeName: string;
    destinationNodeId: string;
    destinationNodeName: string;
  };
}

export interface PaymentInitializeResult {
  authorizationUrl: string;
  providerReference: string;
}

export type PaymentVerificationStatus = 'success' | 'failed' | 'pending';

export interface PaymentVerificationResult {
  status: PaymentVerificationStatus;
  amountKobo: number;
  currency: string;
  paidAt: Date | null;
  providerReference: string;
}

export type PaymentWebhookEventType =
  'charge.success' | 'charge.failed' | 'unknown';

export interface PaymentWebhookEvent {
  type: PaymentWebhookEventType;
  providerReference: string;
}

export type PaymentRefundStatus = 'pending' | 'processed' | 'failed';

export interface PaymentRefundResult {
  status: PaymentRefundStatus;
  providerRefundReference: string;
}

export interface PaymentProvider {
  initialize(params: PaymentInitializeParams): Promise<PaymentInitializeResult>;

  verify(providerReference: string): Promise<PaymentVerificationResult>;

  refund(
    providerReference: string,
    amountKobo?: number,
  ): Promise<PaymentRefundResult>;

  // Raw bytes, not a parsed object — a signature is only valid over the
  // exact bytes the provider signed, and Nest's JSON body-parser can
  // re-serialize a payload differently than it arrived on the wire.
  verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean;

  parseWebhookEvent(rawBody: Buffer): PaymentWebhookEvent;
}
