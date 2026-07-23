import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  seconds,
} from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApp } from '../src/bootstrap';
import { AllExceptionsFilter } from '../src/common/filters';
import { ConfigModule } from '../src/config/config.module';

@Controller('throttle-test')
class ThrottleTestController {
  @Throttle({ default: { limit: 2, ttl: seconds(60) } })
  @Get('limited')
  limited(): { ok: boolean } {
    return { ok: true };
  }
}

// Deliberately its own module, not AppModule — CommonModule's real
// ThrottlerModule skips enforcement under NODE_ENV=test (see its comment)
// so the app's own e2e suites aren't throttled by their own repeated
// requests. This proves the underlying mechanism, our route-level @Throttle()
// override, and the 429 -> RATE_LIMITED mapping all still work, independent
// of that test-only skip.
@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRoot([{ ttl: seconds(60), limit: 100 }]),
  ],
  controllers: [ThrottleTestController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class ThrottleTestModule {}

interface ErrorBody {
  success: false;
  error: { code: string };
}

describe('Rate limiting (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ThrottleTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows requests up to the configured limit', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/throttle-test/limited')
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/throttle-test/limited')
      .expect(200);
  });

  it('rejects the request that exceeds the limit with 429 RATE_LIMITED', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/throttle-test/limited')
      .expect(429);

    expect((response.body as ErrorBody).error.code).toBe('RATE_LIMITED');
  });
});
