import { Injectable, OnModuleInit } from '@nestjs/common';
import { LogisticsProviderRegistry } from '../application/logistics-provider.registry';
import { IN_HOUSE_PROVIDER_KEY } from '../application/in-house-provider-key';
import { DeliveryLegStatus, VehicleClass } from '../domain/delivery-leg';
import type {
  CreateDeliveryResult,
  LogisticsProvider,
  ProviderCapabilities,
} from '../domain/ports/logistics-provider.port';

// Locoomo's own riders, as just another provider. "Creating a delivery" is
// putting the leg in the pool: riders browse and claim it (handoffs'
// available-orders/accept), and progress comes from the in-house handover
// endpoints rather than a remote API. Modelling the pool this way is what
// makes falling back to it no different from routing to any other courier.
@Injectable()
export class InHouseRidersProvider implements LogisticsProvider, OnModuleInit {
  readonly key = IN_HOUSE_PROVIDER_KEY;
  readonly capabilities: ProviderCapabilities = {
    vehicleClasses: [VehicleClass.BICYCLE, VehicleClass.MOTORBIKE],
    handover: 'locoomo_code',
    updates: 'internal',
    remoteSubmission: false,
    cancellableUntil: DeliveryLegStatus.REQUESTED,
    prepaidWallet: false,
  };

  constructor(private readonly registry: LogisticsProviderRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  createDelivery(): Promise<CreateDeliveryResult> {
    return Promise.resolve({
      externalId: null,
      status: DeliveryLegStatus.REQUESTED,
      providerStatus: null,
      quotedKobo: null,
      trackingUrl: null,
    });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}
