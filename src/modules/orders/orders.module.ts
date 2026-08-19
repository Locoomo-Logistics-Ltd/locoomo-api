import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderQueryService } from './application/order-query.service';
import { OrdersService } from './application/orders.service';
import { OrderEventEntity } from './infrastructure/entities/order-event.entity';
import { OrderEntity } from './infrastructure/entities/order.entity';
import { OrdersController } from './interface/orders.controller';

@Module({
  imports: [TypeOrmModule.forFeature([OrderEntity, OrderEventEntity])],
  controllers: [OrdersController],
  providers: [OrdersService, OrderQueryService],
  exports: [OrdersService],
})
export class OrdersModule {}
