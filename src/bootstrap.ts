import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createAppValidationPipe } from './common/pipes';
import { CORRELATION_ID_HEADER } from './common/constants/correlation-id.constant';
import { Env } from './config/env.validation';

// Must match PaymentWebhooksController's route exactly — the full resolved
// path (global prefix + version + controller + method path).
const PAYSTACK_WEBHOOK_PATH = '/api/v1/payments/webhooks/paystack';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);

  // /health stays unprefixed/unversioned — it's an infra probe target (Railway/Render), not app-facing API surface.
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Registered before Nest's own JSON body parser runs — Paystack's webhook
  // signature is computed over the raw request bytes, and re-serializing an
  // already-parsed body can produce a different byte sequence than what they
  // actually signed (see PaystackPaymentProvider.verifyWebhookSignature).
  // Scoped to exactly this one path; every other route keeps normal JSON
  // parsing.
  app.use(PAYSTACK_WEBHOOK_PATH, express.raw({ type: 'application/json' }));

  app.useGlobalPipes(createAppValidationPipe());

  app.use(cookieParser());

  app.enableCors({
    origin: config
      .get('CORS_ORIGIN', { infer: true })
      .split(',')
      .map((origin) => origin.trim()),
    credentials: true,
    exposedHeaders: [CORRELATION_ID_HEADER],
  });
}
