import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Env } from '../../../config/env.validation';
import { LogisticsProviderError } from '../domain/ports/logistics-provider.port';
import { DeliveryEventsService } from './delivery-events.service';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

const RECONCILE_INTERVAL_MS = 3 * 60_000;
// A remote leg nobody has heard about for this long gets polled.
const STALE_AFTER_MINUTES = 5;
const BATCH_SIZE = 50;

interface LegToCheck {
  id: string;
  providerKey: string;
  externalId: string | null;
}

// The safety net under webhooks, for every remote courier:
// - polls in-progress deliveries that have gone quiet (webhooks lost, our
//   endpoint down, a provider-side delay) and applies the provider's state;
// - gives up on deliveries still waiting for a rider after the provider's
//   assignTimeoutMinutes — cancels them with the provider and routes the
//   order onward (another attempt, or the in-house pool).
@Injectable()
export class DeliveryReconcilerService {
  private readonly logger = new Logger(DeliveryReconcilerService.name);
  private isRunning = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: LogisticsProviderRegistry,
    private readonly deliveryEventsService: DeliveryEventsService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  // Skipped under NODE_ENV=test like the outbox poller; tests call runOnce().
  @Interval(RECONCILE_INTERVAL_MS)
  async handleInterval(): Promise<void> {
    if (this.configService.get('NODE_ENV', { infer: true }) === 'test') {
      return;
    }
    await this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    try {
      await this.expireUnassigned();
      await this.pollStale();
    } finally {
      this.isRunning = false;
    }
  }

  private async expireUnassigned(): Promise<void> {
    const legs = await this.dataSource.query<LegToCheck[]>(
      `SELECT l.id, l."providerKey", l."externalId"
         FROM delivery_legs l
         JOIN logistics_providers p ON p.key = l."providerKey"
        WHERE l.status = 'requested'
          AND p."assignTimeoutMinutes" IS NOT NULL
          AND l."createdAt" < now() - p."assignTimeoutMinutes" * interval '1 minute'
        ORDER BY l."createdAt"
        LIMIT $1`,
      [BATCH_SIZE],
    );

    for (const leg of legs) {
      const provider = this.registry.get(leg.providerKey);
      if (!provider) {
        continue;
      }
      try {
        await provider.cancel(leg.externalId);
      } catch (error) {
        if (error instanceof LogisticsProviderError && !error.retryable) {
          // Too late — a rider took it in the meantime. Catch up instead.
          await this.syncLeg(leg);
        } else {
          this.logger.warn(
            `Couldn't cancel unassigned leg ${leg.id}; will retry: ${String(error)}`,
          );
        }
        continue;
      }
      await this.dataSource.transaction((manager) =>
        this.deliveryEventsService.cancelLeg(leg.id, 'assign_timeout', manager),
      );
      this.logger.log(
        `Leg ${leg.id} (${leg.providerKey}) had no rider in time — cancelled and re-routed`,
      );
    }
  }

  private async pollStale(): Promise<void> {
    const legs = await this.dataSource.query<LegToCheck[]>(
      `SELECT id, "providerKey", "externalId"
         FROM delivery_legs
        WHERE status IN ('requested', 'assigned', 'picked_up', 'returning')
          AND "externalId" IS NOT NULL
          AND "updatedAt" < now() - $1 * interval '1 minute'
        ORDER BY "updatedAt"
        LIMIT $2`,
      [STALE_AFTER_MINUTES, BATCH_SIZE],
    );
    for (const leg of legs) {
      await this.syncLeg(leg);
    }
  }

  private async syncLeg(leg: LegToCheck): Promise<void> {
    const provider = this.registry.get(leg.providerKey);
    if (!provider?.getDelivery || !leg.externalId) {
      return;
    }
    try {
      const snapshot = await provider.getDelivery(leg.externalId);
      await this.dataSource.transaction(async (manager) => {
        const changed = await this.deliveryEventsService.syncFromSnapshot(
          leg.providerKey,
          snapshot,
          manager,
        );
        if (!changed) {
          // Nothing new — touch the leg so it isn't re-polled every run.
          await manager.query(
            `UPDATE delivery_legs SET "updatedAt" = now() WHERE id = $1`,
            [leg.id],
          );
        }
      });
    } catch (error) {
      this.logger.warn(`Reconciling leg ${leg.id} failed: ${String(error)}`);
    }
  }
}
