import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './application/orders.service';
import { OrderEventEntity } from './infrastructure/entities/order-event.entity';
import { OrderEntity } from './infrastructure/entities/order.entity';

@Module({
  imports: [TypeOrmModule.forFeature([OrderEntity, OrderEventEntity])],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
