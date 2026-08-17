import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderQueryService } from './application/order-query.service';
import { OrdersService } from './application/orders.service';
import { RiderEarningsQueryService } from './application/rider-earnings-query.service';
import { OrderEventEntity } from './infrastructure/entities/order-event.entity';
import { OrderEntity } from './infrastructure/entities/order.entity';
import { AdminRiderEarningsController } from './interface/admin-rider-earnings.controller';
import { OrdersController } from './interface/orders.controller';

@Module({
  imports: [TypeOrmModule.forFeature([OrderEntity, OrderEventEntity])],
  controllers: [OrdersController, AdminRiderEarningsController],
  providers: [OrdersService, OrderQueryService, RiderEarningsQueryService],
  exports: [OrdersService],
})
export class OrdersModule {}
