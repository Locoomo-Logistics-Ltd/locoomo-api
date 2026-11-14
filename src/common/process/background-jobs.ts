import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';

// Single switch for every poller/interval job (outbox, payment expiry,
// courier reconciliation, webhooks …):
//  - never under NODE_ENV=test — e2e suites drive pollers explicitly by
//    calling poll()/run() so timers can't race assertions or reach real
//    providers;
//  - only in processes whose PROCESS_ROLE is `worker` or `all`, so the
//    HTTP-serving `api` service never spends request capacity on
//    background backlogs.
export function shouldRunBackgroundJobs(
  config: ConfigService<Env, true>,
): boolean {
  if (config.get('NODE_ENV', { infer: true }) === 'test') {
    return false;
  }
  return config.get('PROCESS_ROLE', { infer: true }) !== 'api';
}
