// ~15 minutes: long enough to cover a slow bank-OTP/3DS step during
// checkout, short enough that an abandoned checkout doesn't hold a Node
export const PAYMENT_INTENT_TTL_MS = 15 * 60 * 1000;

// How often ExpirePaymentIntentsService sweeps for stale PENDING intents.
export const PAYMENT_INTENT_EXPIRY_POLL_INTERVAL_MS = 60 * 1000;

// How long past its TTL an intent keeps retrying when the provider says the
// reference doesn't exist. A real checkout's reference always exists, so
// this normally means a test-era or abandoned row — but a wrong key makes
// every reference look missing, and expiring strands any payment behind it
// (a late webhook is ignored on an EXPIRED intent). A day to catch that.
export const PAYMENT_INTENT_NOT_FOUND_GRACE_MS = 24 * 60 * 60 * 1000;
