import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { SkipResponseEnvelope } from '../common/decorators/skip-response-envelope.decorator';
import { Public } from '../modules/identity/interface/decorators/public.decorator';

// Infra probe target (Railway/Render) — no cookies, must stay reachable
// without a session.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @SkipResponseEnvelope()
  @Public()
  check() {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 5000 }),
    ]);
  }
}
