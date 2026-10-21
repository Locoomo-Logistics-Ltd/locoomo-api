import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DeliveryLegType } from '../domain/delivery-leg';
import type { LogisticsProvider } from '../domain/ports/logistics-provider.port';
import { chooseProvider, ProviderRoutingConfig } from '../domain/routing';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

export interface RoutingChoice {
  provider: LogisticsProvider;
  attemptNumber: number;
}

@Injectable()
export class LogisticsRouterService {
  constructor(private readonly registry: LogisticsProviderRegistry) {}

  async choose(
    orderId: string,
    legType: DeliveryLegType,
    manager: EntityManager,
  ): Promise<RoutingChoice | null> {
    const [order] = await manager.query<
      { originNodeId: string; distanceKm: number }[]
    >(
      `SELECT o."originNodeId",
              ST_Distance(origin.location, dest.location) / 1000 AS "distanceKm"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o.id = $1`,
      [orderId],
    );
    const attempts = await manager.query<
      { providerKey: string; count: number }[]
    >(
      `SELECT "providerKey", COUNT(*)::int AS count FROM delivery_legs
        WHERE "orderId" = $1 AND "legType" = $2 GROUP BY "providerKey"`,
      [orderId, legType],
    );
    const configs = await manager.query<ProviderRoutingConfig[]>(
      `SELECT key, enabled, priority, "maxAttempts", "minDistanceKm",
              "maxDistanceKm", "pilotNodeIds"
         FROM logistics_providers`,
    );

    const attemptsByProvider = Object.fromEntries(
      attempts.map((row) => [row.providerKey, row.count]),
    );
    const registeredKeys = new Set(
      configs.map((c) => c.key).filter((key) => this.registry.get(key)),
    );
    const chosen = chooseProvider(configs, registeredKeys, {
      originNodeId: order.originNodeId,
      distanceKm: Number(order.distanceKm),
      attemptsByProvider,
    });
    if (!chosen) {
      return null;
    }

    return {
      provider: this.registry.get(chosen.key)!,
      attemptNumber: attempts.reduce((sum, row) => sum + row.count, 0) + 1,
    };
  }
}
