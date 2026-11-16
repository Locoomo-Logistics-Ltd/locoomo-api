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
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import type { Env } from '../../../config/env.validation';
import { AdminPermissionService } from '../../identity/application/admin-permission.service';
import { renderEmail } from '../../notifications/application/email-template';
import { OutboxService } from '../../notifications/application/outbox.service';

const INTERVAL_NAME = 'platform-health';
const INTERVAL_MS = 10 * 60_000;
// While a check stays breached, ops are reminded this often.
const REMIND_AFTER_MS = 6 * 3_600_000;

export interface HealthCheck {
  key: string;
  label: string;
  value: number;
  unit: 'count' | 'minutes' | 'hours';
  // Breached above this; null = informational only.
  threshold: number | null;
  ok: boolean;
}

export interface PlatformHealth {
  checkedAt: string;
  ok: boolean;
  checks: HealthCheck[];
  openAlerts: { key: string; openedAt: string; lastValue: number }[];
}

// Each check: a query returning one number, and when it's a problem.
const CHECKS: {
  key: string;
  label: string;
  unit: HealthCheck['unit'];
  threshold: number | null;
  sql: string;
}[] = [
  {
    key: 'outbox_lag',
    label: 'Oldest email/job waiting in the outbox',
    unit: 'minutes',
    threshold: 15,
    sql: `SELECT coalesce(extract(epoch FROM now() - min("nextAttemptAt")) / 60, 0)
            FROM outbox_events WHERE status = 'pending' AND "nextAttemptAt" <= now()`,
  },
  {
    key: 'outbox_failed_24h',
    label: 'Outbox jobs failed for good (24 h)',
    unit: 'count',
    threshold: 0,
    sql: `SELECT count(*) FROM outbox_events
           WHERE status = 'failed' AND "updatedAt" > now() - interval '24 hours'`,
  },
  {
    key: 'webhook_lag',
    label: 'Oldest merchant webhook waiting to be sent',
    unit: 'minutes',
    threshold: 30,
    sql: `SELECT coalesce(extract(epoch FROM now() - min("nextAttemptAt")) / 60, 0)
            FROM webhook_deliveries WHERE status = 'pending' AND "nextAttemptAt" <= now()`,
  },
  {
    key: 'failing_webhook_endpoints',
    label: 'Merchant webhook endpoints failing for over an hour',
    unit: 'count',
    threshold: null,
    sql: `SELECT count(*) FROM webhook_endpoints
           WHERE enabled AND "failingSince" < now() - interval '1 hour'`,
  },
  {
    key: 'reroute_queue_age',
    label: 'Oldest parcel waiting for a reroute decision',
    unit: 'hours',
    threshold: 4,
    sql: `SELECT coalesce(extract(epoch FROM now() - min("rerouteRequestedAt")) / 3600, 0)
            FROM orders WHERE "rerouteState" = 'pending'`,
  },
  {
    key: 'kyc_queue_age',
    label: 'Oldest merchant application waiting for review',
    unit: 'hours',
    threshold: 48,
    sql: `SELECT coalesce(extract(epoch FROM now() - min("submittedAt")) / 3600, 0)
            FROM merchants WHERE status IN ('submitted', 'in_review')`,
  },
  {
    key: 'negative_live_wallets',
    label: 'Live merchant wallets below zero',
    unit: 'count',
    threshold: null,
    sql: `SELECT count(*) FROM merchant_wallets WHERE mode = 'live' AND "balanceKobo" < 0`,
  },
  {
    key: 'sealed_bags_without_courier',
    label: 'Sealed bags with no courier for over 30 minutes',
    unit: 'count',
    threshold: 0,
    sql: `SELECT count(*) FROM bags b
           WHERE b.status = 'sealed' AND b."sealedAt" < now() - interval '30 minutes'
             AND NOT EXISTS (
               SELECT 1 FROM delivery_legs l WHERE l."bagId" = b.id
                 AND l.status IN ('requested', 'assigned', 'picked_up', 'returning'))`,
  },
  {
    key: 'parcels_missing_from_bags',
    label: 'Bags with parcels still unscanned a day after arrival',
    unit: 'count',
    threshold: 0,
    sql: `SELECT count(*) FROM bags
           WHERE status = 'arrived' AND "missingAlertedAt" IS NOT NULL`,
  },
];

// Platform health (plan §10, M6b): a handful of numbers that say whether
// the merchant platform is keeping up. Workers check every 10 minutes and
// email ops when a check breaches its threshold (once, a reminder every 6
// hours while it lasts; closed quietly when it clears).
@Injectable()
export class PlatformHealthService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PlatformHealthService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly adminPermissions: AdminPermissionService,
    private readonly outbox: OutboxService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (shouldRunBackgroundJobs(this.config)) {
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => void this.tick(), INTERVAL_MS),
      );
    }
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  async health(): Promise<PlatformHealth> {
    const checks = await this.measure();
    const open = await this.dataSource.query<
      { key: string; openedAt: Date; lastValue: number }[]
    >(
      `SELECT key, "openedAt", "lastValue" FROM ops_alerts
        WHERE "resolvedAt" IS NULL ORDER BY "openedAt"`,
    );
    return {
      checkedAt: new Date().toISOString(),
      ok: checks.every((c) => c.ok),
      checks,
      openAlerts: open.map((a) => ({
        key: a.key,
        openedAt: a.openedAt.toISOString(),
        lastValue: a.lastValue,
      })),
    };
  }

  // Opens, reminds about and closes alerts. Returns the keys emailed.
  async run(now = new Date()): Promise<string[]> {
    const checks = await this.measure();
    const emailed: HealthCheck[] = [];
    await this.dataSource.transaction(async (manager) => {
      for (const check of checks) {
        const [open] = await manager.query<
          { id: string; lastAlertedAt: Date }[]
        >(
          `SELECT id, "lastAlertedAt" FROM ops_alerts
            WHERE key = $1 AND "resolvedAt" IS NULL FOR UPDATE`,
          [check.key],
        );
        if (check.ok) {
          if (open) {
            await manager.query(
              `UPDATE ops_alerts SET "resolvedAt" = $2, "lastValue" = $3 WHERE id = $1`,
              [open.id, now, check.value],
            );
          }
          continue;
        }
        if (!open) {
          await manager.query(
            `INSERT INTO ops_alerts (key, "openedAt", "lastAlertedAt", "lastValue")
             VALUES ($1, $2, $2, $3)`,
            [check.key, now, check.value],
          );
          emailed.push(check);
        } else if (
          now.getTime() - open.lastAlertedAt.getTime() >=
          REMIND_AFTER_MS
        ) {
          await manager.query(
            `UPDATE ops_alerts SET "lastAlertedAt" = $2, "lastValue" = $3 WHERE id = $1`,
            [open.id, now, check.value],
          );
          emailed.push(check);
        } else {
          await manager.query(
            `UPDATE ops_alerts SET "lastValue" = $2 WHERE id = $1`,
            [open.id, check.value],
          );
        }
      }
      if (emailed.length > 0) {
        await this.email(emailed, manager);
      }
    });
    return emailed.map((c) => c.key);
  }

  private async measure(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];
    for (const check of CHECKS) {
      const [row] = await this.dataSource.query<Record<string, unknown>[]>(
        `${check.sql}`,
      );
      const raw = Object.values(row ?? {})[0];
      const value = Math.round(Number(raw ?? 0) * 10) / 10;
      checks.push({
        key: check.key,
        label: check.label,
        value,
        unit: check.unit,
        threshold: check.threshold,
        ok: check.threshold === null || value <= check.threshold,
      });
    }
    return checks;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const emailed = await this.run();
      if (emailed.length) {
        this.logger.warn(`Platform health alerts: ${emailed.join(', ')}`);
      }
    } catch (error) {
      this.logger.error(`Platform health check failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async email(
    breached: HealthCheck[],
    manager: Parameters<OutboxService['enqueueEmail']>[1],
  ): Promise<void> {
    const ops = (await this.adminPermissions.list()).filter(
      (admin) =>
        String(admin.status) === 'active' &&
        (admin.adminPermissions.includes(AdminPermission.OPS) ||
          admin.adminPermissions.includes(AdminPermission.SUPER)),
    );
    for (const admin of ops) {
      const { html, text } = renderEmail({
        greetingName: admin.firstName,
        heading: 'Merchant platform needs attention',
        blocks: [
          {
            kind: 'details',
            rows: breached.map((c) => ({
              label: c.label,
              value: `${c.value} ${c.unit} (alert above ${c.threshold})`,
            })),
          },
          {
            kind: 'paragraph',
            text: 'See Admin › Platform health for the full picture. You get a reminder every 6 hours while a check stays over its threshold.',
          },
        ],
      });
      await this.outbox.enqueueEmail(
        {
          to: admin.email,
          subject:
            `Platform alert: ${breached.map((c) => c.label).join('; ')}`.slice(
              0,
              200,
            ),
          text,
          html,
        },
        manager,
      );
    }
  }
}
