import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { DeliveryDispatchService } from './application/delivery-dispatch.service';
import { DeliveryEventBus } from './application/delivery-event-bus';
import { DeliveryEventsService } from './application/delivery-events.service';
import { DeliveryQueryService } from './application/delivery-query.service';
import { LogisticsProviderRegistry } from './application/logistics-provider.registry';
import { LogisticsRouterService } from './application/logistics-router.service';
import { DeliveryLegEntity } from './infrastructure/entities/delivery-leg.entity';
import { LogisticsProviderConfigEntity } from './infrastructure/entities/logistics-provider-config.entity';
import { InHouseRidersProvider } from './infrastructure/in-house-riders.provider';

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
  ],
  exports: [
    LogisticsProviderRegistry,
    DeliveryEventBus,
    DeliveryDispatchService,
    DeliveryEventsService,
    DeliveryQueryService,
  ],
})
export class LogisticsModule {}
