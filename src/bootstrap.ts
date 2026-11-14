import { INestApplication, VersioningType } from '@nestjs/common';
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { Request } from 'express';
import helmet from 'helmet';
import { createAppValidationPipe } from './common/pipes';
import { CORRELATION_ID_HEADER } from './common/constants/correlation-id.constant';
import { CSRF_HEADER } from './common/auth/csrf.guard';
import { bodyParserErrorMapper } from './common/http/body-parser-errors';
import { Env } from './config/env.validation';

// Must match PaymentWebhooksController's route exactly — the full resolved
// path (global prefix + version + controller + method path).
const PAYSTACK_WEBHOOK_PATH = '/api/v1/payments/webhooks/paystack';
// Prefix for every courier's webhook (CourierWebhooksController,
// /api/v1/logistics/webhooks/:providerKey) — same raw-body reason.
const COURIER_WEBHOOKS_PATH = '/api/v1/logistics/webhooks';

// Explicit request-body ceiling. Express' implicit default is 100kb, which
// bulk endpoints (merchant shipment batches) would exceed; anything larger
// than this goes through async import jobs, not a single JSON body.
export const JSON_BODY_LIMIT = '1mb';

// Headers browser code may send cross-origin (beyond the CORS-safelisted
// ones) and headers it may read from responses.
const ALLOWED_REQUEST_HEADERS = [
  'Content-Type',
  'Authorization',
  CORRELATION_ID_HEADER,
  CSRF_HEADER,
  'Idempotency-Key',
  'Locoomo-Mode',
];
const EXPOSED_RESPONSE_HEADERS = [
  CORRELATION_ID_HEADER,
  'Idempotent-Replayed',
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

// Merchant endpoints a buyer's browser calls with a publishable key from the
// merchant's own checkout (any origin): open CORS without credentials. The
// key's allowed-origins list is enforced when the key is checked.
const PUBLISHABLE_KEY_PATHS =
  /^\/api\/v1\/merchant\/(nodes|quotes|ping)(\/|\?|$)/;

export function isPublishableKeyPath(url: string): boolean {
  return PUBLISHABLE_KEY_PATHS.test(url);
}

// Reverse proxies in front of the app. Without this, request.ip is the
// proxy for every user, so per-IP limits are shared by everyone.
export function trustProxyHops(
  config: ConfigService<Env, true>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    config.get('TRUST_PROXY_HOPS', { infer: true }) ??
    (isOnRailway(env) ? 1 : 0)
  );
}

// Railway always injects these into a running service (the older
// RAILWAY_ENVIRONMENT alias isn't guaranteed on every project).
function isOnRailway(env: NodeJS.ProcessEnv): boolean {
  return !!(
    env.RAILWAY_ENVIRONMENT_ID ||
    env.RAILWAY_PROJECT_ID ||
    env.RAILWAY_ENVIRONMENT
  );
}

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);

  const hops = trustProxyHops(config);
  if (hops > 0) {
    (app as NestExpressApplication).set('trust proxy', hops);
  }

  // /health stays unprefixed/unversioned — it's an infra probe target (Railway/Render), not app-facing API surface.
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Security headers. This is a JSON API (no HTML pages), so helmet's
  // defaults fit as-is: nosniff, frame-deny, HSTS, no-referrer, a CSP that
  // blocks everything (harmless for JSON, and kills any chance of an error
  // body being rendered as a page).
  app.use(helmet());

  // Registered before the JSON parser below — Paystack's webhook signature
  // is computed over the raw request bytes, and re-serializing an
  // already-parsed body can produce a different byte sequence than what they
  // actually signed (see PaystackPaymentProvider.verifyWebhookSignature).
  // Scoped to exactly these paths; every other route keeps normal JSON
  // parsing (the JSON parser skips a body that's already been read).
  app.use(
    PAYSTACK_WEBHOOK_PATH,
    express.raw({ type: 'application/json', limit: JSON_BODY_LIMIT }),
  );
  app.use(
    COURIER_WEBHOOKS_PATH,
    express.raw({ type: 'application/json', limit: JSON_BODY_LIMIT }),
  );
  (app as NestExpressApplication).useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
  });
  app.use(bodyParserErrorMapper(JSON_BODY_LIMIT));

  app.useGlobalPipes(createAppValidationPipe());

  app.use(cookieParser());

  const sessionCors: CorsOptions = {
    origin: config
      .get('CORS_ORIGIN', { infer: true })
      .split(',')
      .map((origin) => origin.trim()),
    credentials: true,
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
  };
  const publishableCors: CorsOptions = {
    origin: true,
    credentials: false,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', CORRELATION_ID_HEADER],
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
    maxAge: 600,
  };
  const corsFor: CorsOptionsDelegate<Request> = (request, callback) => {
    callback(
      null,
      isPublishableKeyPath(request.originalUrl ?? request.url)
        ? publishableCors
        : sessionCors,
    );
  };
  app.enableCors(corsFor);
}
