import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';
import type { Request } from 'express';
import type Redis from 'ioredis';
import { Env } from '../config/env.validation';
import { AuthExtensionsModule } from './auth/auth-extensions.module';
import { CsrfGuard } from './auth/csrf.guard';
import { looksLikeApiKey } from './auth/principal';
import { AllExceptionsFilter } from './filters';
import {
  CorrelationIdInterceptor,
  ResponseEnvelopeInterceptor,
} from './interceptors';
import { REDIS_CLIENT, RedisModule, RedisThrottlerStorage } from './redis';

function hasApiKeyBearer(request: Request): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(
    request.headers.authorization ?? '',
  );
  return !!match && looksLikeApiKey(match[1]);
}

@Module({
  imports: [
    RedisModule,
    AuthExtensionsModule,
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      useFactory: (
        configService: ConfigService<Env, true>,
        redis: Redis | null,
      ) => ({
        throttlers: [
          {
            ttl: seconds(60),
            limit: 100,
            // API-key traffic has its own per-key limits, enforced once
            // the key is known (merchants' ApiRateLimiter); integrators
            // behind one NAT would otherwise share 100/min.
            skipIf: (context) =>
              configService.get('NODE_ENV', { infer: true }) === 'test' ||
              hasApiKeyBearer(context.switchToHttp().getRequest<Request>()),
          },
        ],
        // Shared counters across replicas when Redis is configured;
        // otherwise the library's in-memory default (single instance only).
        ...(redis ? { storage: new RedisThrottlerStorage(redis) } : {}),
      }),
      inject: [ConfigService, REDIS_CLIENT],
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    // Registered before identity's AuthGuard/RolesGuard (CommonModule is
    // imported first in AppModule) — reject excessive requests before
    // spending any effort verifying a session.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Before AuthGuard too: a cross-site forged request is rejected (or, in
    // report mode, logged) without touching the session at all.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class CommonModule {}
