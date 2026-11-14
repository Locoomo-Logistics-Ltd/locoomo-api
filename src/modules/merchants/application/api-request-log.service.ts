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
import {
  CursorPage,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import { Env } from '../../../config/env.validation';
import type { ListApiRequestsQueryDto } from '../interface/dto/api-key.dto';

export interface ApiRequestView {
  id: string;
  apiKeyId: string;
  apiKeyName: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string | null;
  correlationId: string | null;
  createdAt: string;
}

interface Row extends Omit<ApiRequestView, 'createdAt'> {
  createdAt: Date;
}

export const API_REQUEST_RETENTION_DAYS = 30;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_BATCH = 10_000;
const INTERVAL_NAME = 'merchant-api-request-purge';

// Developers › API logs, and its 30-day retention.
@Injectable()
export class ApiRequestLogService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ApiRequestLogService.name);
  private purging = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (shouldRunBackgroundJobs(this.config)) {
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => void this.purge(), PURGE_INTERVAL_MS),
      );
    }
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  async list(
    merchantId: string,
    query: ListApiRequestsQueryDto,
  ): Promise<CursorPage<ApiRequestView>> {
    const after = decodeCursor(query.cursor);
    const params: unknown[] = [merchantId, query.mode, query.limit + 1];
    const where: string[] = [`r."merchantId" = $1`, `r.mode = $2`];
    if (query.apiKeyId) {
      params.push(query.apiKeyId);
      where.push(`r."apiKeyId"::text = $${params.length}`);
    }
    if (query.outcome === 'errors') {
      where.push(`r."statusCode" >= 400`);
    }
    if (after) {
      params.push(after.t, after.id);
      where.push(
        `(${cursorTime('r."createdAt"')}, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows = await this.dataSource.query<Row[]>(
      `SELECT r.id, r."apiKeyId", k.name AS "apiKeyName", r.method, r.path,
              r."statusCode", r."durationMs", r.ip, r."correlationId", r."createdAt"
         FROM merchant_api_requests r
         LEFT JOIN api_keys k ON k.id = r."apiKeyId"
        WHERE ${where.join(' AND ')}
        ORDER BY ${cursorTime('r."createdAt"')} DESC, r.id DESC
        LIMIT $3`,
      params,
    );
    return toCursorPage(
      rows,
      query.limit,
      (row) => ({ t: row.createdAt.toISOString(), id: row.id }),
      (row) => ({ ...row, createdAt: row.createdAt.toISOString() }),
    );
  }

  // Batched so one run never holds a long lock on a busy table.
  async purge(): Promise<number> {
    if (this.purging) {
      return 0;
    }
    this.purging = true;
    let total = 0;
    try {
      for (;;) {
        const [, removed] = await this.dataSource.query<[unknown[], number]>(
          `DELETE FROM merchant_api_requests WHERE id IN (
             SELECT id FROM merchant_api_requests
              WHERE "createdAt" < now() - make_interval(days => $1)
              LIMIT $2)`,
          [API_REQUEST_RETENTION_DAYS, PURGE_BATCH],
        );
        total += removed;
        if (removed < PURGE_BATCH) {
          break;
        }
      }
    } catch (error) {
      this.logger.error(`API request log purge failed: ${String(error)}`);
    } finally {
      this.purging = false;
    }
    return total;
  }
}
