// ~15 minutes: long enough to cover a slow bank-OTP/3DS step during
// checkout, short enough that an abandoned checkout doesn't hold a Node
export const PAYMENT_INTENT_TTL_MS = 15 * 60 * 1000;

// How often ExpirePaymentIntentsService sweeps for stale PENDING intents.
export const PAYMENT_INTENT_EXPIRY_POLL_INTERVAL_MS = 60 * 1000;
