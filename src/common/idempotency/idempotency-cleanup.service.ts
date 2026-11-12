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
import { Env } from '../../config/env.validation';
import { shouldRunBackgroundJobs } from '../process/background-jobs';

const INTERVAL_NAME = 'idempotency-cleanup';
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const DELETE_BATCH = 5_000;

// Purges expired HTTP Idempotency-Key rows (merchant volume makes these
// pile up fast). "Seen" markers from withIdempotency have no expiresAt and
// are never touched. Batched so one run never holds a long lock.
@Injectable()
export class IdempotencyCleanupService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(IdempotencyCleanupService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!shouldRunBackgroundJobs(this.config)) {
      return;
    }
    this.scheduler.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.purge(), CLEANUP_INTERVAL_MS),
    );
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  async purge(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    let total = 0;
    try {
      for (;;) {
        const [, deleted] = await this.dataSource.query<[unknown[], number]>(
          `DELETE FROM idempotency_keys
            WHERE id IN (
              SELECT id FROM idempotency_keys
               WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now()
               LIMIT $1
            )`,
          [DELETE_BATCH],
        );
        total += deleted;
        if (deleted < DELETE_BATCH) {
          break;
        }
      }
    } catch (error) {
      this.logger.error(
        `Idempotency cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
    return total;
  }
}
