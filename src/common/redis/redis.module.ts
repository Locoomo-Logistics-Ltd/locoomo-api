import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '../../config/env.validation';
import { REDIS_CLIENT } from './redis.constants';
import {
  InMemorySharedCache,
  RedisSharedCache,
  SharedCache,
} from './shared-cache';

const logger = new Logger('RedisModule');

// Global: rate limiting (CommonModule), auth caches (identity, merchants)
// and the session denylist all need the same client/cache.
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService<Env, true>): Redis | null => {
        const url = config.get('REDIS_URL', { infer: true });
        if (!url) {
          if (config.get('NODE_ENV', { infer: true }) === 'production') {
            logger.warn(
              'REDIS_URL not set — rate limits, auth caches and session revocation are per-process. Safe only with a single API instance.',
            );
          }
          return null;
        }
        return new Redis(url, {
          // Fail a command fast rather than queueing forever while Redis is
          // unreachable — callers treat a Redis error as a normal failure.
          maxRetriesPerRequest: 2,
          enableOfflineQueue: true,
        });
      },
      inject: [ConfigService],
    },
    {
      provide: SharedCache,
      useFactory: (redis: Redis | null): SharedCache =>
        redis ? new RedisSharedCache(redis) : new InMemorySharedCache(),
      inject: [REDIS_CLIENT],
    },
  ],
  exports: [REDIS_CLIENT, SharedCache],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis?.quit();
  }
}
