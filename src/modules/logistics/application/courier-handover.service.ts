import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LogisticsProviderUnavailableException } from '../domain/exceptions/logistics-provider-unavailable.exception';
import {
  HandoverCodes,
  LogisticsProviderError,
} from '../domain/ports/logistics-provider.port';
import { DeliveryLegEntity } from '../infrastructure/entities/delivery-leg.entity';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

export interface CourierHandoverInfo {
  providerLabel: string;
  courier: {
    name: string | null;
    phone: string | null;
    vehicle: string | null;
  };
  pickupCode: string | null;
  deliveryCode: string | null;
}

// Live handover codes for an external courier's current leg — what Node
// staff read out to the courier, who enters it in their own app. Fetched
// from the provider on every call and never stored or logged: the codes are
// credentials (whoever holds one can take the parcel).
@Injectable()
export class CourierHandoverService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: LogisticsProviderRegistry,
  ) {}

  // null when the order's current leg isn't one that uses provider codes
  // (in-house riders, or no courier assigned yet).
  // A bagged parcel (M5b) is handed over with its bag: the bag's codes.
  async handoverFor(orderId: string): Promise<CourierHandoverInfo | null> {
    const leg = await this.dataSource
      .getRepository(DeliveryLegEntity)
      .createQueryBuilder('leg')
      .where(
        `(leg."orderId" = :orderId OR leg."bagId" = (SELECT "bagId" FROM orders WHERE id = :orderId))`,
        { orderId },
      )
      .andWhere(`leg.status IN ('assigned', 'picked_up', 'returning')`)
      .getOne();
    return this.handoverForLeg(leg);
  }

  async handoverForBag(bagId: string): Promise<CourierHandoverInfo | null> {
    const leg = await this.dataSource
      .getRepository(DeliveryLegEntity)
      .createQueryBuilder('leg')
      .where('leg."bagId" = :bagId', { bagId })
      .andWhere(`leg.status IN ('assigned', 'picked_up', 'returning')`)
      .getOne();
    return this.handoverForLeg(leg);
  }

  private async handoverForLeg(
    leg: DeliveryLegEntity | null,
  ): Promise<CourierHandoverInfo | null> {
    const provider = leg && this.registry.get(leg.providerKey);
    if (
      !leg?.externalId ||
      !provider?.getHandoverCodes ||
      provider.capabilities.handover !== 'provider_code'
    ) {
      return null;
    }

    let codes: HandoverCodes;
    try {
      codes = await provider.getHandoverCodes(leg.externalId);
    } catch (error) {
      if (error instanceof LogisticsProviderError) {
        throw new LogisticsProviderUnavailableException(
          leg.providerKey,
          'getHandoverCodes',
          error.message,
        );
      }
      throw error;
    }
    const [{ label }] = await this.dataSource.query<{ label: string }[]>(
      `SELECT label FROM logistics_providers WHERE key = $1`,
      [leg.providerKey],
    );
    return {
      providerLabel: label,
      courier: {
        name: leg.courierName,
        phone: leg.courierPhone,
        vehicle: leg.courierVehicle,
      },
      ...codes,
    };
  }
}
