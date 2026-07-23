import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';
import { Env } from '../config/env.validation';
import { AllExceptionsFilter } from './filters';
import {
  CorrelationIdInterceptor,
  ResponseEnvelopeInterceptor,
} from './interceptors';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService<Env, true>) => [
        {
          ttl: seconds(60),
          limit: 100,
          skipIf: () =>
            configService.get('NODE_ENV', { infer: true }) === 'test',
        },
      ],
      inject: [ConfigService],
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
  ],
})
export class CommonModule {}
