import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { NodeOperatorsModule } from '../node-operators/node-operators.module';
import { OrdersModule } from '../orders/orders.module';
import { RidersModule } from '../riders/riders.module';
import { AcceptOrderService } from './application/accept-order.service';
import { BrowseAvailableOrdersService } from './application/browse-available-orders.service';
import { ConfirmDropOffService } from './application/confirm-drop-off.service';
import { OrderLookupService } from './application/order-lookup.service';
import { HandoffsController } from './interface/handoffs.controller';

@Module({
  imports: [
    // OrdersModule: OrdersService.assignRider/markReceivedAtOrigin (narrow writes).
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
  ],
})
export class HandoffsModule {}
