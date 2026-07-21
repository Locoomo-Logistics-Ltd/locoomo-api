import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { SkipResponseEnvelope } from '../common/decorators/skip-response-envelope.decorator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @SkipResponseEnvelope()
  check() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }
}
