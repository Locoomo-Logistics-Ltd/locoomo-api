import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

// The `delivery` object on order responses — the order's current leg (or,
// once finished, its latest one), in courier-neutral terms.
export interface DeliveryView {
  provider: string;
  providerLabel: string;
  type: string;
  status: string;
  vehicleClass: string | null;
  // How the next counter handover is proven: the in-house rider shows a
  // code staff enter, or staff read an external courier's code to them.
  handover: 'enter_rider_code' | 'give_code_to_courier';
  courier: {
    name: string | null;
    phone?: string | null;
    vehicle: string | null;
  } | null;
  etaMinutes: number | null;
  attemptNumber: number;
  updatedAt: Date;
}

// Who's asking decides what's visible: Node staff call couriers, so they
// see the courier's phone; senders only ever see a name.
export type DeliveryAudience = 'node' | 'consumer';

interface LegRow {
  orderId: string;
  providerKey: string;
  providerLabel: string;
  legType: string;
  status: string;
  vehicleClass: string | null;
  courierName: string | null;
  courierPhone: string | null;
  courierVehicle: string | null;
  etaMinutes: number | null;
  attemptNumber: number;
  updatedAt: Date;
}

@Injectable()
export class DeliveryQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: LogisticsProviderRegistry,
  ) {}

  async viewsFor(
    orderIds: readonly string[],
    audience: DeliveryAudience,
  ): Promise<Map<string, DeliveryView>> {
    if (orderIds.length === 0) {
      return new Map();
    }
    // Per order: the active leg if there is one, else the most recent.
    const rows = await this.dataSource.query<LegRow[]>(
      `SELECT DISTINCT ON (l."orderId")
              l."orderId", l."providerKey", p.label AS "providerLabel",
              l."legType", l.status, l."vehicleClass", l."courierName",
              l."courierPhone", l."courierVehicle", l."etaMinutes",
              l."attemptNumber", l."updatedAt"
         FROM delivery_legs l
         JOIN logistics_providers p ON p.key = l."providerKey"
        WHERE l."orderId" = ANY($1)
        ORDER BY l."orderId",
                 (l.status IN ('requested', 'assigned', 'picked_up', 'returning')) DESC,
                 l."createdAt" DESC`,
      [orderIds],
    );

    return new Map(
      rows.map((row) => [row.orderId, this.toView(row, audience)]),
    );
  }

  async viewFor(
    orderId: string,
    audience: DeliveryAudience,
  ): Promise<DeliveryView | null> {
    return (await this.viewsFor([orderId], audience)).get(orderId) ?? null;
  }

  private toView(row: LegRow, audience: DeliveryAudience): DeliveryView {
    const hasCourier = row.courierName !== null || row.courierVehicle !== null;
    const handover =
      this.registry.get(row.providerKey)?.capabilities.handover ===
      'provider_code'
        ? 'give_code_to_courier'
        : 'enter_rider_code';
    return {
      provider: row.providerKey,
      providerLabel: row.providerLabel,
      type: row.legType,
      status: row.status,
      vehicleClass: row.vehicleClass,
      handover,
      courier: hasCourier
        ? {
            name: row.courierName,
            ...(audience === 'node' ? { phone: row.courierPhone } : {}),
            vehicle: row.courierVehicle,
          }
        : null,
      etaMinutes: row.etaMinutes,
      attemptNumber: row.attemptNumber,
      updatedAt: row.updatedAt,
    };
  }
}
