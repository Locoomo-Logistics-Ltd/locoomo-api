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
import { Env } from '../../../config/env.validation';
import { OrdersService } from '../../orders/application/orders.service';
import { PublicHolidayService } from '../../orders/application/public-holiday.service';
import { ParcelRecallService } from './parcel-recall.service';
import { ReceiverNotificationService } from './receiver-notification.service';

const INTERVAL_NAME = 'collection-window';
const INTERVAL_MS = 10 * 60 * 1000;
const BATCH = 100;
// Reminders go out on working days 5 and 6 of the 7-day window (§5.5):
// once working day k has ended, reminder k-3 is due.
const REMINDER_AFTER_WORKING_DAYS = [4, 5] as const;

interface ShelvedOrder {
  id: string;
  source: string;
  merchantId: string | null;
  trackingCode: string;
  consumerId: string | null;
  receiverEmail: string | null;
  receiverPhone: string | null;
  parcelDescription: string;
  originNodeId: string;
  destinationNodeId: string;
  collectionDeadlineAt: Date;
  collectionRemindersSent: number;
  shelvedAt: Date;
}

export interface CollectionWindowRun {
  reminded: number;
  returned: number;
}

// The collection window (D15, plan §5.4–5.5) for every parcel on a
// destination shelf, consumer or merchant: reminders on working days 5
// and 6, then at the deadline the parcel goes back to the sender —
// receiver code voided, a return courier booked from the destination
// Node, sender and receiver told. Worker processes run it every 10
// minutes; e2e suites call run() directly.
@Injectable()
export class CollectionWindowService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(CollectionWindowService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ordersService: OrdersService,
    private readonly holidays: PublicHolidayService,
    private readonly parcelRecall: ParcelRecallService,
    private readonly receiverNotificationService: ReceiverNotificationService,
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

  async run(now = new Date()): Promise<CollectionWindowRun> {
    const returned = await this.returnExpired(now);
    const reminded = await this.sendReminders(now);
    return { reminded, returned };
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.run();
      if (result.reminded || result.returned) {
        this.logger.log(
          `Collection window: ${result.reminded} reminded, ${result.returned} returned`,
        );
      }
    } catch (error) {
      this.logger.error(`Collection window run failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async returnExpired(now: Date): Promise<number> {
    const due = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM orders
        WHERE status = 'ready_for_collection' AND "collectionDeadlineAt" < $1
        ORDER BY "collectionDeadlineAt"
        LIMIT $2`,
      [now, BATCH],
    );
    let returned = 0;
    for (const { id } of due) {
      try {
        if (await this.returnOne(id, now)) {
          returned++;
        }
      } catch (error) {
        // One bad order mustn't stop the rest; it's retried next run.
        this.logger.error(
          `Couldn't return uncollected order ${id}: ${String(error)}`,
        );
      }
    }
    return returned;
  }

  private async returnOne(orderId: string, now: Date): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lockShelved(manager, orderId);
      // Collected (or handled) since we listed it.
      if (!order || order.collectionDeadlineAt >= now) {
        return false;
      }
      await this.parcelRecall.returnFromShelf(
        orderId,
        'not_collected',
        manager,
      );
      return true;
    });
  }

  private async sendReminders(now: Date): Promise<number> {
    const candidates = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM orders
        WHERE status = 'ready_for_collection'
          AND "collectionDeadlineAt" IS NOT NULL
          AND "collectionRemindersSent" < $1
        ORDER BY "collectionDeadlineAt"
        LIMIT $2`,
      [REMINDER_AFTER_WORKING_DAYS.length, BATCH * 5],
    );
    let reminded = 0;
    for (const { id } of candidates) {
      try {
        if (await this.remindOne(id, now)) {
          reminded++;
        }
      } catch (error) {
        this.logger.error(`Couldn't remind order ${id}: ${String(error)}`);
      }
    }
    return reminded;
  }

  private async remindOne(orderId: string, now: Date): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lockShelved(manager, orderId);
      if (!order) {
        return false;
      }
      const next = order.collectionRemindersSent;
      const afterDays = REMINDER_AFTER_WORKING_DAYS[next];
      if (afterDays === undefined) {
        return false;
      }
      const dueAt = await this.holidays.addWorkingDays(
        order.shelvedAt,
        afterDays,
      );
      if (now <= dueAt || now >= order.collectionDeadlineAt) {
        return false;
      }
      // Catching up after downtime: send one reminder, not a burst.
      const skipTo =
        next === 0 &&
        now >
          (await this.holidays.addWorkingDays(
            order.shelvedAt,
            REMINDER_AFTER_WORKING_DAYS[1],
          ))
          ? 2
          : next + 1;
      await this.receiverNotificationService.enqueueCollectionReminder(
        order,
        order.collectionDeadlineAt,
        manager,
      );
      for (let sent = next; sent < skipTo; sent++) {
        await this.ordersService.recordCollectionReminder(orderId, manager, {
          reminder: sent + 1,
          collectBy: order.collectionDeadlineAt.toISOString(),
          ...(sent + 1 < skipTo && { skipped: true }),
        });
      }
      return true;
    });
  }

  // Row-locked; null unless still on the destination shelf.
  private async lockShelved(
    manager: EntityManager,
    orderId: string,
  ): Promise<ShelvedOrder | null> {
    const [order] = await manager.query<ShelvedOrder[]>(
      `SELECT o.id, o.source, o."merchantId", o."trackingCode", o."consumerId", o."receiverEmail",
              o."receiverPhone", o."parcelDescription", o."originNodeId",
              o."destinationNodeId", o."collectionDeadlineAt",
              o."collectionRemindersSent",
              COALESCE(
                (SELECT max(e."createdAt") FROM order_events e
                  WHERE e."orderId" = o.id AND e.type = 'ready_for_collection'),
                o."updatedAt"
              ) AS "shelvedAt"
         FROM orders o
        WHERE o.id = $1 AND o.status = 'ready_for_collection'
          AND o."collectionDeadlineAt" IS NOT NULL
        FOR UPDATE OF o`,
      [orderId],
    );
    return order ?? null;
  }
}
