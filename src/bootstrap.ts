import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { createAppValidationPipe } from './common/pipes';
import { CORRELATION_ID_HEADER } from './common/constants/correlation-id.constant';
import { Env } from './config/env.validation';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);

  // /health stays unprefixed/unversioned — it's an infra probe target (Railway/Render), not app-facing API surface.
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
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
