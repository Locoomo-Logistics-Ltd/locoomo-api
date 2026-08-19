import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { EarningsModule } from '../earnings/earnings.module';
import { NodeOperatorsModule } from '../node-operators/node-operators.module';
import { NodesModule } from '../nodes/nodes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { RidersModule } from '../riders/riders.module';
import { AcceptOrderService } from './application/accept-order.service';
import { BrowseAvailableOrdersService } from './application/browse-available-orders.service';
import { ConfirmCollectionService } from './application/confirm-collection.service';
import { ConfirmDropOffService } from './application/confirm-drop-off.service';
import { ConfirmHandoffService } from './application/confirm-handoff.service';
import { ConfirmIntakeService } from './application/confirm-intake.service';
import { HandoffCodeIssuerService } from './application/handoff-code-issuer.service';
import { HandoffCodeValidatorService } from './application/handoff-code-validator.service';
import { ListMyNodeOrdersService } from './application/list-my-node-orders.service';
import { ListMyOrdersService } from './application/list-my-orders.service';
import { OrderLookupService } from './application/order-lookup.service';
import { RequestHandoffCodeService } from './application/request-handoff-code.service';
import { ResendCollectionCodeService } from './application/resend-collection-code.service';
import { HandoffCodeEntity } from './infrastructure/entities/handoff-code.entity';
import { HandoffsController } from './interface/handoffs.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([HandoffCodeEntity]),
    // OrdersModule: OrdersService narrow writes (assignRider,
    // markReceivedAtOrigin, markPickedUpByRider, markArrivedAtDestination,
    // markReadyForCollection, markCollected).
    // RidersModule: RiderCapacityService.reserveDeliverySlot/releaseDeliverySlot.
    // NodeOperatorsModule: NodeOperatorQueryService.getNodeIdForUser.
    // NodesModule: NodesService.releaseCapacitySlot (origin, on rider pickup).
    // IdempotencyModule: every scan/confirm endpoint (decision #5).
    // NotificationsModule: OutboxService.enqueueEmail (collection code).
    // EarningsModule: RecordRevenueSplitService, on order completion.
    OrdersModule,
    RidersModule,
    NodeOperatorsModule,
    NodesModule,
    IdempotencyModule,
    NotificationsModule,
    EarningsModule,
  ],
  controllers: [HandoffsController],
  providers: [
    BrowseAvailableOrdersService,
    AcceptOrderService,
    OrderLookupService,
    ConfirmDropOffService,
    HandoffCodeIssuerService,
    HandoffCodeValidatorService,
    RequestHandoffCodeService,
    ConfirmHandoffService,
    ConfirmIntakeService,
    ResendCollectionCodeService,
    ConfirmCollectionService,
    ListMyOrdersService,
    ListMyNodeOrdersService,
  ],
})
export class HandoffsModule {}
