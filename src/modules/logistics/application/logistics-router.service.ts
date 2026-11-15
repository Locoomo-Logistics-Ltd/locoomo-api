import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DeliveryLegType } from '../domain/delivery-leg';
import type { LogisticsProvider } from '../domain/ports/logistics-provider.port';
import { chooseProvider, ProviderRoutingConfig } from '../domain/routing';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

export interface RoutingChoice {
  provider: LogisticsProvider;
  attemptNumber: number;
  // See logistics_providers.maxCostShare.
  maxCostShare: number | null;
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
      {
        originNodeId: string;
        distanceKm: number;
        vehicleClass: string | null;
      }[]
    >(
      `SELECT o."originNodeId", o."vehicleClass",
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

    const { configs, registeredKeys } = await this.loadConfigs(manager);
    const chosen = chooseProvider(configs, registeredKeys, {
      originNodeId: order.originNodeId,
      distanceKm: Number(order.distanceKm),
      vehicleClass: order.vehicleClass,
      attemptsByProvider: Object.fromEntries(
        attempts.map((row) => [row.providerKey, row.count]),
      ),
    });
    if (!chosen) {
      return null;
    }

    return {
      provider: this.registry.get(chosen.key)!,
      attemptNumber: attempts.reduce((sum, row) => sum + row.count, 0) + 1,
      maxCostShare: chosen.maxCostShare,
    };
  }

  // A sealed bag (M5b): the same policy, but only couriers that carry bags,
  // with the bag's vehicle and the bag's own attempts.
  async chooseForBag(
    bagId: string,
    vehicleClass: string,
    manager: EntityManager,
  ): Promise<RoutingChoice | null> {
    const [bag] = await manager.query<
      { originNodeId: string; distanceKm: number }[]
    >(
      `SELECT b."originNodeId",
              ST_Distance(origin.location, dest.location) / 1000 AS "distanceKm"
         FROM bags b
         JOIN nodes origin ON origin.id = b."originNodeId"
         JOIN nodes dest ON dest.id = b."destinationNodeId"
        WHERE b.id = $1`,
      [bagId],
    );
    const attempts = await manager.query<
      { providerKey: string; count: number }[]
    >(
      `SELECT "providerKey", COUNT(*)::int AS count FROM delivery_legs
        WHERE "bagId" = $1 GROUP BY "providerKey"`,
      [bagId],
    );
    const { configs, registeredKeys } = await this.loadConfigs(manager);
    const chosen = chooseProvider(
      configs.filter(
        (config) => this.registry.get(config.key)?.capabilities.carriesBags,
      ),
      registeredKeys,
      {
        originNodeId: bag.originNodeId,
        distanceKm: Number(bag.distanceKm),
        vehicleClass,
        attemptsByProvider: Object.fromEntries(
          attempts.map((row) => [row.providerKey, row.count]),
        ),
      },
    );
    if (!chosen) {
      return null;
    }
    return {
      provider: this.registry.get(chosen.key)!,
      attemptNumber: attempts.reduce((sum, row) => sum + row.count, 0) + 1,
      maxCostShare: chosen.maxCostShare,
    };
  }

  // Checkout's question: would any courier take a parcel needing this
  // vehicle between these Nodes? (Straight-line distance, as the routing
  // limits use.)
  async canServe(
    route: { originNodeId: string; distanceKm: number },
    vehicleClass: string,
    manager: EntityManager,
  ): Promise<boolean> {
    const { configs, registeredKeys } = await this.loadConfigs(manager);
    return (
      chooseProvider(configs, registeredKeys, {
        ...route,
        vehicleClass,
        attemptsByProvider: {},
      }) !== null
    );
  }

  private async loadConfigs(manager: EntityManager): Promise<{
    configs: ProviderRoutingConfig[];
    registeredKeys: Set<string>;
  }> {
    const rows = await manager.query<
      Omit<ProviderRoutingConfig, 'vehicleClasses'>[]
    >(
      `SELECT key, enabled, priority, "maxAttempts", "minDistanceKm",
              "maxDistanceKm", "pilotNodeIds", "maxCostShare"
         FROM logistics_providers`,
    );
    const configs = rows.map((row) => ({
      ...row,
      vehicleClasses:
        this.registry.get(row.key)?.capabilities.vehicleClasses ?? [],
    }));
    const registeredKeys = new Set(
      configs.map((c) => c.key).filter((key) => this.registry.get(key)),
    );
    return { configs, registeredKeys };
  }
}
