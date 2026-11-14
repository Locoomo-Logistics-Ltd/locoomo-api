import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createSecretBox } from '../../../common/crypto/data-encryption-key';
import { SecretBox } from '../../../common/crypto/secret-box';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import { Env } from '../../../config/env.validation';
import {
  DELIVERY_TIMEOUT_MS,
  DISABLE_AFTER_FAILING_HOURS,
  MAX_IN_FLIGHT_PER_ENDPOINT,
  nextRetryDelaySeconds,
  signWebhook,
  WEBHOOK_RETENTION_DAYS,
} from '../domain/webhooks';
import { WebhookDeliveryEntity } from '../infrastructure/entities/webhook-delivery.entity';
import { WebhookEndpointEntity } from '../infrastructure/entities/webhook-endpoint.entity';
import { WebhookEventEntity } from '../infrastructure/entities/webhook-event.entity';
import {
  WebhookResponse,
  WebhookTransport,
} from '../infrastructure/webhook-transport';
import { MerchantNotifierService } from './merchant-notifier.service';

const POLL_INTERVAL_MS = 1_000;
const PURGE_INTERVAL_MS = 60 * 60 * 1_000;
const CLAIM_BATCH = 50;
const CLAIM_LEASE_SECONDS = 60;
const POLL_NAME = 'webhook-dispatch';
const PURGE_NAME = 'webhook-purge';

export interface DeliveryOutcome {
  delivered: boolean;
  responseStatus: number | null;
  durationMs: number;
  error: string | null;
}

// Sends queued webhook deliveries (MERCHANT_API.md §12.5): at-least-once,
// ≤ 4 in flight per endpoint, retried on the documented schedule, and an
// endpoint failing for 36 hours is disabled and its developers emailed.
// Runs in worker processes; e2e suites call dispatchDue() directly.
@Injectable()
export class WebhookDispatcherService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly box: SecretBox;
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transport: WebhookTransport,
    private readonly notifier: MerchantNotifierService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.box = createSecretBox(config, 'webhook-secret');
  }

  onModuleInit(): void {
    if (!shouldRunBackgroundJobs(this.config)) {
      return;
    }
    this.scheduler.addInterval(
      POLL_NAME,
      setInterval(() => void this.tick(), POLL_INTERVAL_MS),
    );
    this.scheduler.addInterval(
      PURGE_NAME,
      setInterval(() => void this.purge(), PURGE_INTERVAL_MS),
    );
  }

  onApplicationShutdown(): void {
    for (const name of [POLL_NAME, PURGE_NAME]) {
      if (this.scheduler.doesExist('interval', name)) {
        this.scheduler.deleteInterval(name);
      }
    }
  }

  sealSecret(secret: string): string {
    return this.box.seal(Buffer.from(secret, 'utf8'));
  }

  // Claims what's due and sends it. Returns how many were attempted.
  async dispatchDue(limit = CLAIM_BATCH): Promise<number> {
    // UPDATE … RETURNING through TypeORM yields [rows, affectedCount].
    const [claimed] = await this.dataSource.query<[{ id: string }[], number]>(
      `WITH inflight AS (
         SELECT "endpointId", count(*)::int AS n
           FROM webhook_deliveries
          WHERE status = 'delivering' AND "lockedUntil" > now()
          GROUP BY "endpointId"
       ), candidates AS (
         SELECT d.id,
                row_number() OVER (PARTITION BY d."endpointId" ORDER BY d."nextAttemptAt", d.id) AS rn,
                COALESCE(i.n, 0) AS busy
           FROM webhook_deliveries d
           JOIN webhook_endpoints e ON e.id = d."endpointId" AND e.enabled
           LEFT JOIN inflight i ON i."endpointId" = d."endpointId"
          WHERE (d.status = 'pending' AND d."nextAttemptAt" <= now())
             OR (d.status = 'delivering' AND d."lockedUntil" <= now())
       )
       UPDATE webhook_deliveries
          SET status = 'delivering',
              "lockedUntil" = now() + make_interval(secs => $2),
              "updatedAt" = now()
        WHERE id IN (SELECT id FROM candidates WHERE rn + busy <= $3 LIMIT $1)
          AND (status = 'pending' OR "lockedUntil" <= now())
       RETURNING id`,
      [limit, CLAIM_LEASE_SECONDS, MAX_IN_FLIGHT_PER_ENDPOINT],
    );
    await Promise.all(claimed.map(({ id }) => this.deliver(id)));
    return claimed.length;
  }

  // One delivery, now, regardless of schedule ("Send test event").
  async deliverNow(deliveryId: string): Promise<DeliveryOutcome> {
    await this.dataSource.query(
      `UPDATE webhook_deliveries SET status = 'delivering',
              "lockedUntil" = now() + make_interval(secs => $2)
        WHERE id = $1`,
      [deliveryId, CLAIM_LEASE_SECONDS],
    );
    return this.deliver(deliveryId);
  }

  async purge(): Promise<number> {
    const [, removed] = await this.dataSource.query<[unknown[], number]>(
      `DELETE FROM webhook_events
        WHERE "createdAt" < now() - make_interval(days => $1)`,
      [WEBHOOK_RETENTION_DAYS],
    );
    return removed;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      // Drain while there's a full batch.
      while ((await this.dispatchDue()) === CLAIM_BATCH) {
        // keep going
      }
    } catch (error) {
      this.logger.error(`Webhook dispatch failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async deliver(deliveryId: string): Promise<DeliveryOutcome> {
    const manager = this.dataSource.manager;
    const delivery = await manager.findOneByOrFail(WebhookDeliveryEntity, {
      id: deliveryId,
    });
    const [event, endpoint] = await Promise.all([
      manager.findOneByOrFail(WebhookEventEntity, { id: delivery.eventId }),
      manager.findOneByOrFail(WebhookEndpointEntity, {
        id: delivery.endpointId,
      }),
    ]);

    const timestamp = Math.floor(Date.now() / 1000);
    const secrets = [this.box.open(endpoint.secretSealed).toString('utf8')];
    if (
      endpoint.previousSecretSealed &&
      endpoint.previousSecretExpiresAt &&
      endpoint.previousSecretExpiresAt.getTime() > Date.now()
    ) {
      secrets.push(
        this.box.open(endpoint.previousSecretSealed).toString('utf8'),
      );
    }
    const response = await this.transport.post(
      endpoint.url,
      event.body,
      {
        'content-type': 'application/json',
        'user-agent': 'Locoomo-Webhooks/1',
        'webhook-id': event.id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': secrets
          .map((secret) => signWebhook(secret, event.id, timestamp, event.body))
          .join(' '),
      },
      DELIVERY_TIMEOUT_MS,
    );
    await this.record(delivery, endpoint, response);
    return {
      delivered: isSuccess(response),
      responseStatus: response.status,
      durationMs: response.durationMs,
      error: response.error,
    };
  }

  private async record(
    delivery: WebhookDeliveryEntity,
    endpoint: WebhookEndpointEntity,
    response: WebhookResponse,
  ): Promise<void> {
    const ok = isSuccess(response);
    const attempts = delivery.attempts + 1;
    const retryIn = ok ? null : nextRetryDelaySeconds(attempts);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(WebhookDeliveryEntity, delivery.id, {
        status: ok ? 'succeeded' : retryIn === null ? 'failed' : 'pending',
        attempts,
        nextAttemptAt: new Date(Date.now() + (retryIn ?? 0) * 1000),
        lockedUntil: null,
        lastAttemptAt: new Date(),
        responseStatus: response.status,
        responseBody: response.body,
        error:
          response.error?.slice(0, 500) ?? (ok ? null : redirectNote(response)),
        durationMs: response.durationMs,
      });
      if (ok) {
        await manager.update(WebhookEndpointEntity, endpoint.id, {
          failingSince: null,
          lastSuccessAt: new Date(),
        });
        return;
      }
      const failingSince = endpoint.failingSince ?? new Date();
      const disable =
        Date.now() - failingSince.getTime() >=
        DISABLE_AFTER_FAILING_HOURS * 3_600_000;
      await manager.update(WebhookEndpointEntity, endpoint.id, {
        failingSince,
        ...(disable && {
          enabled: false,
          disabledReason: `Every delivery failed for ${DISABLE_AFTER_FAILING_HOURS} hours`,
        }),
      });
      if (disable && endpoint.enabled) {
        await this.notifier.webhookEndpointDisabled(
          endpoint.merchantId,
          { url: endpoint.url, mode: endpoint.mode },
          manager,
        );
      }
    });
  }
}

function isSuccess(response: WebhookResponse): boolean {
  return (
    response.status !== null && response.status >= 200 && response.status < 300
  );
}

function redirectNote(response: WebhookResponse): string | null {
  return response.status !== null &&
    response.status >= 300 &&
    response.status < 400
    ? 'Redirects are not followed; point the endpoint at the final URL'
    : null;
}
