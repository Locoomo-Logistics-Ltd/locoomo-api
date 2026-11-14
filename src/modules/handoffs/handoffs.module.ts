import { CollectionCompletionService } from './application/collection-completion.service';
import { CollectWithIdService } from './application/collect-with-id.service';
import { CounterUploadsService } from './application/counter-uploads.service';
import { OrderExceptionService } from './application/order-exception.service';
import { RefuseDropOffService } from './application/refuse-drop-off.service';
import { SenderContactService } from './application/sender-contact.service';
import { SenderNotificationService } from './application/sender-notification.service';
import { AdminOrdersController } from './interface/admin-orders.controller';
import { CloudinaryModule } from '../../common/cloudinary/cloudinary.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogisticsModule } from '../logistics/logistics.module';
import { TrackingModule } from '../tracking/tracking.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { EarningsModule } from '../earnings/earnings.module';
import { NodeOperatorsModule } from '../node-operators/node-operators.module';
import { NodesModule } from '../nodes/nodes.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { RidersModule } from '../riders/riders.module';
import { CollectionWindowService } from './application/collection-window.service';
import { DestinationCapacitySubscriber } from './application/destination-capacity.subscriber';
import { AcceptOrderService } from './application/accept-order.service';
import { BrowseAvailableOrdersService } from './application/browse-available-orders.service';
import { ConfirmCollectionService } from './application/confirm-collection.service';
import { ConfirmDropOffService } from './application/confirm-drop-off.service';
import { ConfirmHandoffService } from './application/confirm-handoff.service';
import { ConfirmIntakeService } from './application/confirm-intake.service';
import { HandoffCodeIssuerService } from './application/handoff-code-issuer.service';
import { HandoffCodeValidatorService } from './application/handoff-code-validator.service';
import { CourierHandoverQueryService } from './application/courier-handover-query.service';
import { DeliveryProgressListener } from './application/delivery-progress.listener';
import { ReturnCollectionService } from './application/return-collection.service';
import { ReturnIntakeService } from './application/return-intake.service';
import { ReturnNotificationService } from './application/return-notification.service';
import { ReceiverNotificationService } from './application/receiver-notification.service';
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
    // TrackingModule: tracking code/QR/link block in receiver emails.
    // LogisticsModule: delivery legs — dispatch at drop-off, in-house
    // claims/handovers, and the delivery events that move the order.
    OrdersModule,
    RidersModule,
    NodeOperatorsModule,
    NodesModule,
    IdempotencyModule,
    NotificationsModule,
    EarningsModule,
    TrackingModule,
    LogisticsModule,
    // Counter photos (refusals, ID-check collections).
    CloudinaryModule,
  ],
  controllers: [HandoffsController, AdminOrdersController],
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
    ReceiverNotificationService,
    ReturnNotificationService,
    ReturnIntakeService,
    ReturnCollectionService,
    DeliveryProgressListener,
    CourierHandoverQueryService,
    CollectionWindowService,
    DestinationCapacitySubscriber,
    CollectionCompletionService,
    CollectWithIdService,
    CounterUploadsService,
    OrderExceptionService,
    RefuseDropOffService,
    SenderContactService,
    SenderNotificationService,
  ],
  // Merchants (M4) register their sender-contact resolver here.
  exports: [SenderContactService],
})
export class HandoffsModule {}
