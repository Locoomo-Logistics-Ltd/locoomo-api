import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogisticsModule } from '../logistics/logistics.module';
import { TrackingModule } from '../tracking/tracking.module';
import { OrderQueryService } from './application/order-query.service';
import { OrdersService } from './application/orders.service';
import { OrderEventEntity } from './infrastructure/entities/order-event.entity';
import { OrderEntity } from './infrastructure/entities/order.entity';
import { OrdersController } from './interface/orders.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([OrderEntity, OrderEventEntity]),
    // TrackingModule: trackingUrl on the Consumer's order responses.
    // LogisticsModule: the `delivery` (current courier) on them.
    TrackingModule,
    LogisticsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrderQueryService],
  exports: [OrdersService],
})
export class OrdersModule {}
