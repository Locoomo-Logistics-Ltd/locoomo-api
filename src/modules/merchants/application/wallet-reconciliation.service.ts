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
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import { lagosDate } from '../../../common/time/working-days';
import { Env } from '../../../config/env.validation';
import { MerchantNotifierService } from './merchant-notifier.service';

const INTERVAL_NAME = 'wallet-reconciliation';
const CHECK_EVERY_MS = 60 * 60 * 1000;
// Runs once per Lagos day, in the first hourly check after 02:00.
const RUN_AFTER_LAGOS_HOUR = 2;

export interface WalletDrift {
  walletId: string;
  merchantId: string;
  mode: string;
  balanceKobo: number;
  ledgerKobo: number;
  heldKobo: number;
  activeHoldsKobo: number;
}

// Nightly check (plan §8.1): each wallet's cached balance must equal the sum
// of its entries, and its held amount the sum of its active holds. Drift is
// reported to finance and never auto-corrected. Paystack-side checks
// (top-ups vs credited) join with M4b.
@Injectable()
export class WalletReconciliationService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WalletReconciliationService.name);
  private lastRunDay: string | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifier: MerchantNotifierService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (shouldRunBackgroundJobs(this.config)) {
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => void this.tick(), CHECK_EVERY_MS),
      );
    }
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  async run(): Promise<WalletDrift[]> {
    const drifts = await this.dataSource.query<WalletDrift[]>(
      `SELECT * FROM (
         SELECT w.id AS "walletId", w."merchantId", w.mode,
                w."balanceKobo"::float8 AS "balanceKobo",
                COALESCE((SELECT SUM(e."amountKobo") FROM wallet_entries e
                           WHERE e."walletId" = w.id), 0)::float8 AS "ledgerKobo",
                w."heldKobo"::float8 AS "heldKobo",
                COALESCE((SELECT SUM(h."amountKobo") FROM wallet_holds h
                           WHERE h."walletId" = w.id AND h.status = 'active'), 0)::float8
                  AS "activeHoldsKobo"
           FROM merchant_wallets w
       ) t
       WHERE t."balanceKobo" <> t."ledgerKobo" OR t."heldKobo" <> t."activeHoldsKobo"`,
    );
    if (drifts.length > 0) {
      this.logger.error(
        `Wallet reconciliation: ${drifts.length} wallet(s) out of balance: ${drifts
          .slice(0, 5)
          .map((d) => d.walletId)
          .join(', ')}`,
      );
      await this.dataSource.transaction((manager) =>
        this.notifier.walletDrift(drifts, manager),
      );
    }
    return drifts;
  }

  private async tick(now = new Date()): Promise<void> {
    const day = lagosDate(now);
    const lagosHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hourCycle: 'h23',
        timeZone: 'Africa/Lagos',
      }).format(now),
    );
    if (
      this.running ||
      this.lastRunDay === day ||
      lagosHour < RUN_AFTER_LAGOS_HOUR
    ) {
      return;
    }
    this.running = true;
    try {
      await this.run();
      this.lastRunDay = day;
    } catch (error) {
      this.logger.error(`Wallet reconciliation failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
