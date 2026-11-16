import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import type { Env } from '../../../config/env.validation';
import { ReturnCollectionService } from '../../handoffs/application/return-collection.service';
import { PublicHolidayService } from '../../orders/application/public-holiday.service';
import {
  DISPOSAL_NOTICE_DAYS,
  disposeAtFor,
  lagosDay,
  RETURN_FREE_WORKING_DAYS,
  storageDaysDue,
} from '../domain/return-storage';
import { ShipmentStatus } from '../domain/shipment';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import { MerchantNotifierService } from './merchant-notifier.service';
import { ShipmentEventsService } from './shipment-events.service';
import { WalletService } from './wallet.service';

const INTERVAL_NAME = 'return-storage';
const INTERVAL_MS = 60 * 60_000;
const BATCH = 500;

export interface ReturnStorageRun {
  scheduled: number;
  charged: number;
  feesStartedNotices: number;
  disposalNotices: number;
  disposed: number;
}

type Stage = 'fees_started' | 'disposal_soon' | 'disposed';

interface Waiting {
  id: string;
  merchantId: string;
  orderId: string | null;
  reference: string;
  trackingCode: string;
  nodeName: string;
  disposeAt: Date | null;
}

// Abandoned merchant returns (plan D20, F4, M6a), hourly on workers:
// a return waiting at its Node (return_ready) is stored free for 10
// working days; then each Lagos day costs RETURN_STORAGE_FEE_KOBO from the
// merchant's wallet (one ledger line per parcel per day). The merchant is
// emailed when fees start and a week before disposal; 30 days after fees
// start the parcel is disposed of (shipment.disposed; ops are told to
// remove it). Test shipments go through the same steps on the test wallet.
@Injectable()
export class ReturnStorageService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ReturnStorageService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
    private readonly holidays: PublicHolidayService,
    private readonly wallet: WalletService,
    private readonly events: ShipmentEventsService,
    private readonly returnCollection: ReturnCollectionService,
    private readonly notifier: MerchantNotifierService,
    private readonly scheduler: SchedulerRegistry,
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

  async run(now = new Date()): Promise<ReturnStorageRun> {
    const scheduled = await this.schedule();
    const charged = await this.charge(now);
    const feesStartedNotices = await this.notify('fees_started', now);
    const disposalNotices = await this.notify('disposal_soon', now);
    const disposed = await this.dispose(now);
    return {
      scheduled,
      charged,
      feesStartedNotices,
      disposalNotices,
      disposed,
    };
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.run();
      if (Object.values(result).some((n) => n > 0)) {
        this.logger.log(`Return storage: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.logger.error(`Return storage run failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  // Newly waiting returns: when fees start, and when they'll be disposed of.
  private async schedule(): Promise<number> {
    const rows = await this.dataSource.query<
      { id: string; readyAt: string | null; statusChangedAt: Date }[]
    >(
      `SELECT id, "returnInfo"->>'readyForCollectionAt' AS "readyAt", "statusChangedAt"
         FROM merchant_shipments
        WHERE status = 'return_ready' AND "storageFeesFrom" IS NULL
        LIMIT ${BATCH}`,
    );
    for (const row of rows) {
      const ready = row.readyAt ? new Date(row.readyAt) : row.statusChangedAt;
      const feesFrom = await this.holidays.addWorkingDays(
        ready,
        RETURN_FREE_WORKING_DAYS,
      );
      await this.dataSource.query(
        `UPDATE merchant_shipments SET "storageFeesFrom" = $2, "disposeAt" = $3
          WHERE id = $1 AND "storageFeesFrom" IS NULL`,
        [row.id, feesFrom, disposeAtFor(feesFrom)],
      );
    }
    return rows.length;
  }

  // Each day owed, once. Locks the order (live) then the shipment, the
  // order every writer takes, and re-checks it's still waiting.
  private async charge(now: Date): Promise<number> {
    const fee = this.config.get('RETURN_STORAGE_FEE_KOBO', { infer: true });
    if (fee <= 0) {
      return 0;
    }
    const due = await this.dataSource.query<
      { id: string; orderId: string | null }[]
    >(
      `SELECT id, "orderId" FROM merchant_shipments
        WHERE status = 'return_ready' AND "storageFeesFrom" <= $1
          AND ("storageChargedThrough" IS NULL OR "storageChargedThrough" < $2::date)
        LIMIT ${BATCH}`,
      [now, lagosDay(now)],
    );
    let charged = 0;
    for (const item of due) {
      charged += await this.dataSource.transaction(async (manager) => {
        const shipment = await this.lockWaiting(manager, item);
        if (!shipment?.storageFeesFrom) {
          return 0;
        }
        const days = storageDaysDue(
          shipment.storageFeesFrom,
          shipment.storageChargedThrough,
          now,
        );
        let n = 0;
        for (const day of days) {
          const entry = await this.wallet.chargeStorage(manager, {
            merchantId: shipment.merchantId,
            mode: shipment.mode,
            shipmentId: shipment.id,
            day,
            amountKobo: fee,
            description: `Storage ${day}: ${shipment.reference} (${shipment.trackingCode})`,
          });
          n += entry ? 1 : 0;
        }
        if (days.length > 0) {
          await manager.update(MerchantShipmentEntity, shipment.id, {
            storageChargedThrough: days[days.length - 1],
          });
        }
        return n;
      });
    }
    return charged;
  }

  // One email per merchant per run, listing its parcels.
  private async notify(stage: Stage, now: Date): Promise<number> {
    const column =
      stage === 'fees_started' ? 'storageNoticeSentAt' : 'disposalNoticeSentAt';
    const condition =
      stage === 'fees_started'
        ? `s."storageFeesFrom" <= $1`
        : `s."disposeAt" <= $1::timestamptz + interval '${DISPOSAL_NOTICE_DAYS} days'`;
    const rows = await this.waiting(`${condition} AND s."${column}" IS NULL`, [
      now,
    ]);
    if (rows.length === 0) {
      return 0;
    }
    const fee = this.config.get('RETURN_STORAGE_FEE_KOBO', { infer: true });
    for (const [merchantId, items] of this.byMerchant(rows)) {
      await this.dataSource.transaction(async (manager) => {
        const merchant = await manager.findOneByOrFail(MerchantEntity, {
          id: merchantId,
        });
        await this.notifier.returnsStorage(
          merchant,
          stage,
          items,
          fee,
          manager,
        );
        await manager.query(
          `UPDATE merchant_shipments SET "${column}" = $2 WHERE id = ANY($1)`,
          [items.map((i) => i.id), now],
        );
      });
    }
    return rows.length;
  }

  // Past their date: disposed of. Live parcels leave the shelf through
  // handoffs (the mirror then marks the shipment disposed and sends
  // shipment.disposed); test ones move directly.
  private async dispose(now: Date): Promise<number> {
    const rows = await this.waiting(`s."disposeAt" <= $1`, [now]);
    const done: (Waiting & { merchantName: string })[] = [];
    for (const item of rows) {
      const disposed = await this.dataSource.transaction(async (manager) => {
        const shipment = await this.lockWaiting(manager, item);
        if (!shipment) {
          return false;
        }
        if (shipment.orderId) {
          if (
            !(await this.returnCollection.dispose(manager, shipment.orderId))
          ) {
            return false;
          }
        } else {
          shipment.status = ShipmentStatus.DISPOSED;
          shipment.statusChangedAt = now;
          await this.events.apply(manager, shipment, ShipmentStatus.DISPOSED, {
            nodeName: shipment.origin.nodeName,
          });
        }
        await manager.query(
          `UPDATE merchant_return_batch_items SET active = false
            WHERE "shipmentId" = $1 AND active`,
          [shipment.id],
        );
        return true;
      });
      if (disposed) {
        const [m] = await this.dataSource.query<{ tradingName: string }[]>(
          `SELECT "tradingName" FROM merchants WHERE id = $1`,
          [item.merchantId],
        );
        done.push({ ...item, merchantName: m.tradingName });
      }
    }
    if (done.length > 0) {
      const fee = this.config.get('RETURN_STORAGE_FEE_KOBO', { infer: true });
      await this.dataSource.transaction(async (manager) => {
        for (const [merchantId, items] of this.byMerchant(done)) {
          const merchant = await manager.findOneByOrFail(MerchantEntity, {
            id: merchantId,
          });
          await this.notifier.returnsStorage(
            merchant,
            'disposed',
            items,
            fee,
            manager,
          );
        }
        // Only real parcels need removing from a Node.
        await this.notifier.returnsDisposedForOps(
          done.filter((d) => d.orderId),
          manager,
        );
      });
    }
    return done.length;
  }

  private async waiting(where: string, params: unknown[]): Promise<Waiting[]> {
    return this.dataSource.query<Waiting[]>(
      `SELECT s.id, s."merchantId", s."orderId", s.reference, s."trackingCode",
              coalesce(s.origin->>'nodeName', '') AS "nodeName", s."disposeAt"
         FROM merchant_shipments s
        WHERE s.status = 'return_ready' AND ${where}
        ORDER BY s."merchantId", s."disposeAt"
        LIMIT ${BATCH}`,
      params,
    );
  }

  private async lockWaiting(
    manager: EntityManager,
    item: { id: string; orderId: string | null },
  ): Promise<MerchantShipmentEntity | null> {
    if (item.orderId) {
      await manager.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [
        item.orderId,
      ]);
    }
    const shipment = await manager
      .getRepository(MerchantShipmentEntity)
      .createQueryBuilder('s')
      .setLock('pessimistic_write')
      .where('s.id = :id', { id: item.id })
      .getOne();
    return shipment?.status === ShipmentStatus.RETURN_READY ? shipment : null;
  }

  private byMerchant<T extends { merchantId: string }>(
    rows: T[],
  ): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      groups.set(row.merchantId, [...(groups.get(row.merchantId) ?? []), row]);
    }
    return groups;
  }
}
