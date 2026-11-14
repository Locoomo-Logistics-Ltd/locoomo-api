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
import { Env } from '../../../config/env.validation';
import { OrdersService } from '../../orders/application/orders.service';
import { ShipmentStatus } from '../domain/shipment';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import { ShipmentEventsService } from './shipment-events.service';
import { WalletService } from './wallet.service';

const INTERVAL_NAME = 'shipment-expiry';
const INTERVAL_MS = 30 * 60 * 1000;
const BATCH = 200;

// Shipments never dropped off by their deadline (MERCHANT_API.md §7.1:
// 60 days hub, 14 days Node) expire: the hold is released and, for live
// ones, the order is cancelled. Both modes. Worker processes run it every
// 30 minutes; e2e suites call run() directly.
@Injectable()
export class ShipmentExpiryService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ShipmentExpiryService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: ShipmentEventsService,
    private readonly wallet: WalletService,
    private readonly orders: OrdersService,
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

  async run(now = new Date()): Promise<number> {
    const due = await this.dataSource.query<
      { id: string; orderId: string | null }[]
    >(
      `SELECT id, "orderId" FROM merchant_shipments
        WHERE status = 'created' AND "dropDeadline" < $1
        ORDER BY "dropDeadline"
        LIMIT $2`,
      [now, BATCH],
    );
    let expired = 0;
    for (const { id, orderId } of due) {
      try {
        if (await this.expireOne(id, orderId, now)) {
          expired++;
        }
      } catch (error) {
        this.logger.error(`Couldn't expire shipment ${id}: ${String(error)}`);
      }
    }
    return expired;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const expired = await this.run();
      if (expired) {
        this.logger.log(`Expired ${expired} shipment(s) never dropped off`);
      }
    } catch (error) {
      this.logger.error(`Shipment expiry failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async expireOne(
    id: string,
    orderId: string | null,
    now: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      // Order before shipment, as every other path (no deadlock with a
      // drop-off scan happening right now).
      if (orderId) {
        await manager.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [
          orderId,
        ]);
      }
      const shipment = await manager
        .getRepository(MerchantShipmentEntity)
        .createQueryBuilder('s')
        .where('s.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
      // Dropped off (or cancelled) since we listed it.
      if (
        !shipment ||
        shipment.status !== ShipmentStatus.CREATED ||
        shipment.dropDeadline >= now
      ) {
        return false;
      }
      shipment.status = ShipmentStatus.EXPIRED;
      shipment.statusChangedAt = now;
      shipment.feeState = 'released';
      await this.wallet.releaseHold(manager, shipment.id);
      await this.events.apply(manager, shipment, 'expired');
      if (orderId) {
        await this.orders.markCancelled(orderId, manager, {
          reason: 'drop_off_expired',
        });
      }
      return true;
    });
  }
}
