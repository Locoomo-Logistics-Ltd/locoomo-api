import { z } from 'zod';

// An optional secret/key: unset, or an empty value in .env, both mean
// "not configured".
const optionalString = () =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  );

// Grows as each module is added — don't pre-declare vars nothing reads yet.
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    // generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
    JWT_ACCESS_SECRET: z.string().min(32),
    // Path to the DB provider's CA cert, repo-relative. Unset locally (docker-compose Postgres has no TLS) - required against Supabase/Neon so the connection verifies
    DATABASE_SSL_CA_PATH: z.string().optional(),
    // domain, e.g. app.locoomo.com + api.locoomo.com) for SameSite=Strict cookies to be sent at all; a genuinely cross-site frontend breaks login.
    CORS_ORIGIN: z.string().min(1),
    // rontend origin used to build links embedded in emails
    // (password reset, email verification, invite)
    FRONTEND_URL: z.url(),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().positive(),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SMTP_USER: z.string().min(1),
    SMTP_PASSWORD: z.string().min(1),
    // "From" header — either a bare address or "Name <address>". Shared by
    // both email transports below (it's an envelope concern, not SMTP-specific).
    SMTP_FROM: z.string().min(1),
    EMAIL_TRANSPORT: z.enum(['smtp', 'resend_api']).default('smtp'),
    // Only required when EMAIL_TRANSPORT=resend_api (enforced below) — same
    // value as SMTP_PASSWORD when using Resend's SMTP relay, but kept as its
    // own var rather than reusing SMTP_PASSWORD under a different meaning.
    RESEND_API_KEY: z.string().min(1).optional(),
    // Signed document uploads — rider verification, merchant KYC (common/cloudinary/cloudinary.service.ts).
    CLOUDINARY_CLOUD_NAME: z.string().min(1),
    CLOUDINARY_API_KEY: z.string().min(1),
    CLOUDINARY_API_SECRET: z.string().min(1),
    // Paystack (payments/infrastructure/paystack-payment-provider.ts) — secret
    // key only; we use hosted-redirect checkout, so no client-side public key
    // is ever needed server-side.
    PAYSTACK_SECRET_KEY: z.string().min(1),
    // Google Sign-In (identity/application/google-auth.service.ts) — the
    // OAuth client ID registered for this app, used as the `audience` when
    // verifying a Google ID token. Public value, not a secret; no client
    // secret is needed since we only ever verify a client-obtained ID token
    // server-side, never do a server-side code exchange.
    GOOGLE_CLIENT_ID: z.string().min(1),
    // Signs the public tracking links put in emails (tracking module) —
    // knowing a tracking code alone isn't enough to view a parcel. Rotating
    // it invalidates every link already sent. Generate like JWT_ACCESS_SECRET.
    TRACKING_LINK_SECRET: z.string().min(32),
    // Sendii courier (logistics/infrastructure/sendii). Key prefix picks the
    // environment: sk_test_… sandbox, sk_live_… live. Optional — without it
    // the Sendii adapter isn't registered and orders route to other couriers.
    SENDII_API_KEY: optionalString(),
    // whsec_… signing secret of the webhook endpoint registered with Sendii
    // (shown once at registration — see `npm run sendii:webhook`).
    SENDII_WEBHOOK_SECRET: optionalString(),
    SENDII_BASE_URL: z.url().default('https://api.sendii.ng/partner/v1'),
    // Google Maps Platform key with the Geocoding API enabled (and billing on
    // the project — Google rejects keys without it). Used to check a Node's
    // map pin against its address (nodes/infrastructure/google-geocoder.ts).
    // Optional: without it every check is recorded as "unverified" instead
    // of blocking Node creation. An empty value counts as unset.
    GOOGLE_MAPS_API_KEY: optionalString(),
    // Encrypts sensitive fields at rest (common/crypto/secret-box): TOTP
    // (2FA) seeds, merchant KYC ID numbers, bank account numbers — each with
    // its own derived sub-key. Generate like JWT_ACCESS_SECRET and set it in
    // every deployed environment.
    // Optional only so existing deploys boot: when unset the key is derived
    // from JWT_ACCESS_SECRET — which then can't be rotated without breaking
    // every enrolled 2FA device. Never change it once users have enrolled.
    DATA_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
    // Shared state across API replicas: rate-limit counters, auth caches
    // (with cross-instance cache busting) and the session denylist. Optional
    // — without it everything falls back to per-process memory, which is
    // correct only while a single instance runs (local dev, CI, today's
    // single Railway service). Required before scaling out to >1 replica.
    REDIS_URL: optionalString(),
    // Which background work this process runs. `all` (default) = HTTP +
    // pollers/intervals in one process, as today. In production run one
    // `api` service (HTTP only) and one or more `worker` services (pollers),
    // so a slow outbox/webhook backlog never competes with request latency.
    PROCESS_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
    // CSRF custom-header check for cookie-authenticated mutating requests
    // (header `X-Locoomo-Client`). Rolled out off → report (log only) →
    // enforce (403) so existing frontends don't break the day it ships.
    CSRF_MODE: z.enum(['off', 'report', 'enforce']).default('report'),
    // Outbox throughput knobs (notifications/application/outbox-poller).
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(50),
    OUTBOX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    // SMS (notifications, D10). Optional by design: with no provider/key
    // configured — or a key the provider rejects — SMS sends are skipped
    // (logged) and every flow continues on its other channels. SMS is never
    // a hard dependency.
    SMS_PROVIDER: z.enum(['none', 'termii']).default('none'),
    SMS_API_KEY: optionalString(),
    // Registered sender ID (Termii requires one approved per account).
    SMS_SENDER_ID: z.string().min(1).max(11).default('Locoomo'),
    // Termii gives each account its own base URL in the dashboard.
    TERMII_BASE_URL: z.url().default('https://v3.api.termii.com'),
    // `generic` is the default route; `dnd` delivers to DND-registered
    // numbers but must be activated on the Termii account first.
    TERMII_CHANNEL: z.enum(['generic', 'dnd']).default('generic'),
    // Global kill switch for the merchant platform (plan §10). `false`
    // answers every /merchant route with 503 MERCHANT_PLATFORM_DISABLED;
    // admin merchant routes keep working so ops can still act.
    MERCHANT_PLATFORM_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    // Merchant dashboard origin for links in merchant emails (invites,
    // review outcomes), e.g. https://merchant.locoomo.com. Defaults to
    // FRONTEND_URL when unset.
    MERCHANT_DASHBOARD_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.url().optional(),
    ),
  })
  .refine(
    (config) =>
      config.EMAIL_TRANSPORT !== 'resend_api' || !!config.RESEND_API_KEY,
    {
      message: 'RESEND_API_KEY is required when EMAIL_TRANSPORT=resend_api',
      path: ['RESEND_API_KEY'],
    },
  );

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
