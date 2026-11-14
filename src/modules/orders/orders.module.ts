import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogisticsModule } from '../logistics/logistics.module';
import { TrackingModule } from '../tracking/tracking.module';
import { OrderQueryService } from './application/order-query.service';
import { OrderStatusEventBus } from './application/order-status-event-bus';
import { OrdersService } from './application/orders.service';
import { PublicHolidayService } from './application/public-holiday.service';
import { OrderEventEntity } from './infrastructure/entities/order-event.entity';
import { OrderEntity } from './infrastructure/entities/order.entity';
import { PublicHolidayEntity } from './infrastructure/entities/public-holiday.entity';
import { AdminPublicHolidaysController } from './interface/admin-public-holidays.controller';
import { OrdersController } from './interface/orders.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      OrderEventEntity,
      PublicHolidayEntity,
    ]),
    // TrackingModule: trackingUrl on the Consumer's order responses.
    // LogisticsModule: the `delivery` (current courier) on them.
    TrackingModule,
    LogisticsModule,
  ],
  controllers: [OrdersController, AdminPublicHolidaysController],
  providers: [
    OrdersService,
    OrderQueryService,
    OrderStatusEventBus,
    PublicHolidayService,
  ],
  // OrderStatusEventBus: other modules subscribe to order status changes
  // (merchant webhooks, notifications, capacity) without orders importing
  // them — same inversion as logistics' DeliveryEventBus.
  // PublicHolidayService: working-day arithmetic for anyone counting
  // collection windows, reminders or fees.
  exports: [OrdersService, OrderStatusEventBus, PublicHolidayService],
})
export class OrdersModule {}
