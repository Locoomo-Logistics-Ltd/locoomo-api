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
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  AppException,
  EntityNotFoundException,
} from '../../../common/exceptions';
import {
  CursorPage,
  decodeOffsetCursor,
  encodeOffsetCursor,
} from '../../../common/pagination/cursor';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import { Env } from '../../../config/env.validation';
import {
  ImportsInProgressException,
  ImportSizeException,
  InvalidImportFileException,
} from '../domain/exceptions/merchant.exceptions';
import {
  CsvFormatError,
  CsvRows,
  csvToShipments,
  ImportRowStatus,
  ImportSource,
  ImportStatus,
  MAX_ACTIVE_IMPORTS,
  MAX_IMPORT_ROWS,
  parseCsv,
} from '../domain/shipment-import';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import { ShipmentImportRowEntity } from '../infrastructure/entities/shipment-import-row.entity';
import { ShipmentImportEntity } from '../infrastructure/entities/shipment-import.entity';
import type { MerchantCaller } from './merchant-state';
import { MerchantShipmentService } from './merchant-shipment.service';

const INTERVAL_NAME = 'shipment-imports';
const INTERVAL_MS = 5_000;
// Rows per claim; the lock is renewed per chunk.
const CHUNK = 100;
const LOCK_MS = 2 * 60 * 1000;
// How long one tick keeps working before letting the next one start.
const TICK_BUDGET_MS = 20_000;
const INSERT_BATCH = 1_000;

export interface ImportView {
  id: string;
  mode: 'test' | 'live';
  source: ImportSource;
  status: ImportStatus;
  fileName: string | null;
  totalRows: number;
  created: number;
  failed: number;
  pending: number;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ImportRowView {
  index: number;
  // CSV line (1 = header); null for JSON imports.
  line: number | null;
  status: ImportRowStatus;
  reference: string | null;
  shipmentId: string | null;
  error: { code: string; message: string; details?: unknown } | null;
}

const importView = (i: ShipmentImportEntity): ImportView => ({
  id: i.id,
  mode: i.mode,
  source: i.source,
  status: i.status,
  fileName: i.fileName,
  totalRows: i.totalRows,
  created: i.createdCount,
  failed: i.failedCount,
  pending: i.totalRows - i.createdCount - i.failedCount,
  failureReason: i.failureReason,
  createdAt: i.createdAt.toISOString(),
  completedAt: i.completedAt?.toISOString() ?? null,
});

// Shipment imports (MERCHANT_API.md §7.3): accepted at once, then created
// in the background row by row through exactly the path POST /shipments
// takes (validation, wallet hold, live rules). Worker processes run it
// every few seconds; e2e suites call run() directly.
@Injectable()
export class ShipmentImportService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ShipmentImportService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly shipments: MerchantShipmentService,
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

  // ─── Accepting ────────────────────────────────────────────────────────

  async fromJson(
    caller: MerchantCaller,
    items: Record<string, unknown>[],
  ): Promise<ImportView> {
    return this.accept(caller, 'json', null, items, null);
  }

  async fromCsv(
    caller: MerchantCaller,
    csv: string,
    fileName: string | null,
  ): Promise<ImportView> {
    let parsed: CsvRows;
    try {
      parsed = csvToShipments(parseCsv(csv));
    } catch (error) {
      if (error instanceof CsvFormatError) {
        throw new InvalidImportFileException(error.message);
      }
      throw error;
    }
    return this.accept(caller, 'csv', fileName, parsed.items, parsed.lines);
  }

  private async accept(
    caller: MerchantCaller,
    source: ImportSource,
    fileName: string | null,
    items: Record<string, unknown>[],
    lines: number[] | null,
  ): Promise<ImportView> {
    // Fail fast on what would fail every row (live not open, suspended…).
    await this.shipments.creatableMerchant(caller);
    if (items.length === 0 || items.length > MAX_IMPORT_ROWS) {
      throw new ImportSizeException(items.length, MAX_IMPORT_ROWS);
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      // Serialises the active-imports check per merchant.
      await manager.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [
        caller.merchantId,
      ]);
      const [{ active }] = await manager.query<{ active: number }[]>(
        `SELECT count(*)::int AS active FROM shipment_imports
          WHERE "merchantId" = $1 AND mode = $2 AND status IN ('queued', 'processing')`,
        [caller.merchantId, caller.mode],
      );
      if (active >= MAX_ACTIVE_IMPORTS) {
        throw new ImportsInProgressException(MAX_ACTIVE_IMPORTS);
      }
      const created = await manager.save(
        manager.create(ShipmentImportEntity, {
          merchantId: caller.merchantId,
          mode: caller.mode,
          source,
          status: 'queued',
          fileName: fileName?.slice(0, 255) ?? null,
          totalRows: items.length,
          createdCount: 0,
          failedCount: 0,
          failureReason: null,
          createdByKeyId: caller.keyId,
          createdByUserId: caller.userId,
          lockedUntil: null,
          completedAt: null,
        }),
      );
      for (let start = 0; start < items.length; start += INSERT_BATCH) {
        await manager.insert(
          ShipmentImportRowEntity,
          items.slice(start, start + INSERT_BATCH).map((input, offset) => ({
            importId: created.id,
            index: start + offset,
            line: lines?.[start + offset] ?? null,
            status: 'pending' as const,
            input,
            shipmentId: null,
            error: null,
          })) as QueryDeepPartialEntity<ShipmentImportRowEntity>[],
        );
      }
      return created;
    });
    return importView(saved);
  }

  // ─── Reading ──────────────────────────────────────────────────────────

  async get(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<ImportView> {
    return importView(await this.importOf(caller, id));
  }

  async list(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<ImportView>> {
    const offset = decodeOffsetCursor(cursor);
    const rows = await this.dataSource.manager.find(ShipmentImportEntity, {
      where: { merchantId: caller.merchantId, mode: caller.mode },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: offset,
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map(importView),
      nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
      hasMore,
    };
  }

  // Rows in file order; `status` narrows (e.g. failed, to fix and re-run).
  async rows(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
    status: ImportRowStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<ImportRowView>> {
    await this.importOf(caller, id);
    const after = decodeOffsetCursor(cursor);
    const qb = this.dataSource.manager
      .getRepository(ShipmentImportRowEntity)
      .createQueryBuilder('r')
      .where('r."importId" = :id AND r.index >= :after', { id, after })
      .orderBy('r.index', 'ASC')
      .take(limit + 1);
    if (status) {
      qb.andWhere('r.status = :status', { status });
    }
    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        index: r.index,
        line: r.line,
        status: r.status,
        reference:
          typeof r.input.reference === 'string' ? r.input.reference : null,
        shipmentId: r.shipmentId,
        error: r.error,
      })),
      nextCursor: hasMore
        ? encodeOffsetCursor(page[page.length - 1].index + 1)
        : null,
      hasMore,
    };
  }

  // ─── Processing (worker) ──────────────────────────────────────────────

  // Works through queued imports until there's nothing left or the time
  // budget runs out. Returns rows processed.
  async run(budgetMs = TICK_BUDGET_MS): Promise<number> {
    const started = Date.now();
    let processed = 0;
    while (Date.now() - started < budgetMs) {
      const claimed = await this.claim();
      if (!claimed) {
        break;
      }
      processed += await this.processChunk(claimed);
    }
    return processed;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.run();
    } catch (error) {
      this.logger.error(`Shipment imports failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  // The oldest open import nobody is working on, locked for a while.
  private async claim(): Promise<ShipmentImportEntity | null> {
    const [rows] = await this.dataSource.query<[{ id: string }[], number]>(
      `UPDATE shipment_imports SET status = 'processing', "lockedUntil" = $1, "updatedAt" = now()
        WHERE id = (
          SELECT id FROM shipment_imports
           WHERE status IN ('queued', 'processing')
             AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
           ORDER BY "createdAt"
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [new Date(Date.now() + LOCK_MS)],
    );
    if (!rows[0]) {
      return null;
    }
    return this.dataSource.manager.findOneByOrFail(ShipmentImportEntity, {
      id: rows[0].id,
    });
  }

  private async processChunk(job: ShipmentImportEntity): Promise<number> {
    const caller: MerchantCaller = {
      merchantId: job.merchantId,
      mode: job.mode,
      via: job.createdByKeyId ? 'api_key' : 'session',
      keyId: job.createdByKeyId,
      userId: job.createdByUserId,
      context: { ip: null, userAgent: null, correlationId: null },
    };
    const pending = await this.dataSource.manager.find(
      ShipmentImportRowEntity,
      {
        where: { importId: job.id, status: 'pending' },
        order: { index: 'ASC' },
        take: CHUNK,
      },
    );
    if (pending.length === 0) {
      await this.finish(job.id, null);
      return 0;
    }

    let merchant;
    try {
      merchant = await this.shipments.creatableMerchant(caller);
    } catch (error) {
      if (!(error instanceof AppException)) {
        throw error;
      }
      // The account can't create shipments any more (suspended, live
      // closed…): every row that's left fails with that reason.
      const reason = { code: error.errorCode, message: error.message };
      await this.dataSource.query(
        `UPDATE shipment_import_rows SET status = 'failed', error = $2
          WHERE "importId" = $1 AND status = 'pending'`,
        [job.id, reason],
      );
      await this.finish(job.id, error.message);
      return pending.length;
    }

    let created = 0;
    let failed = 0;
    for (const row of pending) {
      const result = await this.shipments.createItem(
        caller,
        merchant,
        row.input,
        '',
      );
      let shipmentId: string | null = result.ok ? result.shipment.id : null;
      if (!result.ok && result.error.code === 'DUPLICATE_REFERENCE') {
        // Created by this import before an interruption? Then it's done.
        shipmentId = await this.createdByThisImport(job, result.error.details);
      }
      await this.dataSource.manager.update(
        ShipmentImportRowEntity,
        { importId: job.id, index: row.index },
        shipmentId
          ? { status: 'created', shipmentId, error: null }
          : ({
              status: 'failed',
              error: result.ok ? null : result.error,
            } as QueryDeepPartialEntity<ShipmentImportRowEntity>),
      );
      if (shipmentId) {
        created++;
      } else {
        failed++;
      }
    }
    await this.dataSource.query(
      `UPDATE shipment_imports
          SET "createdCount" = "createdCount" + $2, "failedCount" = "failedCount" + $3,
              "lockedUntil" = $4, "updatedAt" = now()
        WHERE id = $1`,
      [job.id, created, failed, new Date(Date.now() + LOCK_MS)],
    );
    if (pending.length < CHUNK) {
      await this.finish(job.id, null);
    } else {
      // Let the next claim pick it (or another import) up.
      await this.dataSource.query(
        `UPDATE shipment_imports SET "lockedUntil" = NULL WHERE id = $1`,
        [job.id],
      );
    }
    return pending.length;
  }

  private async createdByThisImport(
    job: ShipmentImportEntity,
    details: unknown,
  ): Promise<string | null> {
    const existingId = (details as { existingShipmentId?: string } | undefined)
      ?.existingShipmentId;
    if (!existingId) {
      return null;
    }
    const shipment = await this.dataSource.manager.findOneBy(
      MerchantShipmentEntity,
      { id: existingId, merchantId: job.merchantId, mode: job.mode },
    );
    const ours =
      shipment &&
      shipment.createdAt >= job.createdAt &&
      shipment.createdByKeyId === job.createdByKeyId &&
      shipment.createdByUserId === job.createdByUserId;
    return ours ? shipment.id : null;
  }

  private async finish(
    id: string,
    failureReason: string | null,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE shipment_imports
          SET status = $2, "failureReason" = $3, "completedAt" = now(),
              "lockedUntil" = NULL, "updatedAt" = now(),
              "createdCount" = (SELECT count(*) FROM shipment_import_rows WHERE "importId" = $1 AND status = 'created'),
              "failedCount" = (SELECT count(*) FROM shipment_import_rows WHERE "importId" = $1 AND status = 'failed')
        WHERE id = $1`,
      [
        id,
        failureReason ? 'failed' : 'done',
        failureReason?.slice(0, 500) ?? null,
      ],
    );
  }

  private async importOf(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<ShipmentImportEntity> {
    const found = await this.dataSource.manager.findOneBy(
      ShipmentImportEntity,
      {
        id,
        merchantId: caller.merchantId,
        mode: caller.mode,
      },
    );
    if (!found) {
      throw new EntityNotFoundException('Shipment import', id);
    }
    return found;
  }
}
