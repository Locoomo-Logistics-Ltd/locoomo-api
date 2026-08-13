import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { NodeOperatorsModule } from '../node-operators/node-operators.module';
import { OrdersModule } from '../orders/orders.module';
import { RidersModule } from '../riders/riders.module';
import { AcceptOrderService } from './application/accept-order.service';
import { BrowseAvailableOrdersService } from './application/browse-available-orders.service';
import { ConfirmDropOffService } from './application/confirm-drop-off.service';
import { ConfirmHandoffService } from './application/confirm-handoff.service';
import { OrderLookupService } from './application/order-lookup.service';
import { RequestHandoffCodeService } from './application/request-handoff-code.service';
import { HandoffCodeEntity } from './infrastructure/entities/handoff-code.entity';
import { HandoffsController } from './interface/handoffs.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([HandoffCodeEntity]),
    // OrdersModule: OrdersService narrow writes (assignRider,
    // markReceivedAtOrigin, markPickedUpByRider, markArrivedAtDestination).
    // RidersModule: RiderCapacityService.reserveDeliverySlot/releaseDeliverySlot.
    // NodeOperatorsModule: NodeOperatorQueryService.getNodeIdForUser.
    // IdempotencyModule: every scan/confirm endpoint (decision #5).
    OrdersModule,
    RidersModule,
    NodeOperatorsModule,
    IdempotencyModule,
  ],
  controllers: [HandoffsController],
  providers: [
    BrowseAvailableOrdersService,
    AcceptOrderService,
    OrderLookupService,
    ConfirmDropOffService,
    RequestHandoffCodeService,
    ConfirmHandoffService,
  ],
})
export class HandoffsModule {}
