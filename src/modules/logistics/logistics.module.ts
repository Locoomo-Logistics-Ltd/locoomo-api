import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminLogisticsService } from './application/admin-logistics.service';
import { CourierWalletService } from './application/courier-wallet.service';
import { CourierHandoverService } from './application/courier-handover.service';
import { CourierWebhookService } from './application/courier-webhook.service';
import { DeliveryReconcilerService } from './application/delivery-reconciler.service';
import { DeliveryDispatchService } from './application/delivery-dispatch.service';
import { DeliveryEventBus } from './application/delivery-event-bus';
import { DeliveryEventsService } from './application/delivery-events.service';
import { DeliveryQueryService } from './application/delivery-query.service';
import { LogisticsProviderRegistry } from './application/logistics-provider.registry';
import { RouteDistanceService } from './application/route-distance.service';
import { VehicleSelectionService } from './application/vehicle-selection.service';
import { LogisticsRouterService } from './application/logistics-router.service';
import { DeliveryLegEntity } from './infrastructure/entities/delivery-leg.entity';
import { LogisticsInboundEventEntity } from './infrastructure/entities/logistics-inbound-event.entity';
import { LogisticsProviderConfigEntity } from './infrastructure/entities/logistics-provider-config.entity';
import { InHouseRidersProvider } from './infrastructure/in-house-riders.provider';
import { SendiiProvider } from './infrastructure/sendii/sendii.provider';
import { AdminLogisticsController } from './interface/admin-logistics.controller';
import { CourierWebhooksController } from './interface/courier-webhooks.controller';

// Couriers as a pluggable layer: who carries each parcel between Nodes
// (delivery legs), which courier gets it (routing over logistics_providers),
// and how their progress reaches the order flow (DeliveryEventBus). In-house
// riders are one provider among others; external couriers (Sendii first)
// plug in as adapters registered with LogisticsProviderRegistry.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DeliveryLegEntity,
      LogisticsProviderConfigEntity,
      LogisticsInboundEventEntity,
    ]),
    // OutboxService + OutboxHandlerRegistry: remote submission runs as a
    // 'logistics.submit' outbox job.
    NotificationsModule,
  ],
  providers: [
    LogisticsProviderRegistry,
    DeliveryEventBus,
    LogisticsRouterService,
    DeliveryDispatchService,
    DeliveryEventsService,
    DeliveryQueryService,
    InHouseRidersProvider,
    SendiiProvider,
    CourierWebhookService,
    DeliveryReconcilerService,
    CourierHandoverService,
    VehicleSelectionService,
    RouteDistanceService,
    CourierWalletService,
    AdminLogisticsService,
  ],
  controllers: [CourierWebhooksController, AdminLogisticsController],
  exports: [
    LogisticsProviderRegistry,
    DeliveryEventBus,
    DeliveryDispatchService,
    DeliveryEventsService,
    DeliveryQueryService,
    CourierHandoverService,
    VehicleSelectionService,
    RouteDistanceService,
    LogisticsRouterService,
  ],
})
export class LogisticsModule {}
