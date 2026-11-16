import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxHandlerRegistry } from '../../notifications/application/outbox-handler.registry';
import { OutboxService } from '../../notifications/application/outbox.service';
import {
  ACTIVE_LEG_STATUSES,
  DeliveryLegStatus,
  DeliveryLegType,
  VehicleClass,
  bagVehicleClass,
} from '../domain/delivery-leg';
import {
  CreateDeliveryRequest,
  DeliveryStop,
  LogisticsProviderError,
} from '../domain/ports/logistics-provider.port';
import { DeliveryLegEntity } from '../infrastructure/entities/delivery-leg.entity';
import { LogisticsProviderRegistry } from './logistics-provider.registry';
import {
  LogisticsRouterService,
  RoutingChoice,
} from './logistics-router.service';
import { RouteDistanceService } from './route-distance.service';

export const SUBMIT_DELIVERY_EVENT_TYPE = 'logistics.submit';

interface StopRow {
  nodeId: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  contactPhone: string | null;
}

// Puts an order's parcel in a courier's hands: picks the provider
// (LogisticsRouterService), records the leg, and hands it to the provider.
// Local providers (the in-house pool) are handed it inside the caller's
// transaction; remote ones through the outbox, so the HTTP call never runs
// inside the drop-off transaction and is retried if it fails transiently.
@Injectable()
export class DeliveryDispatchService implements OnModuleInit {
  private readonly logger = new Logger(DeliveryDispatchService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly router: LogisticsRouterService,
    private readonly registry: LogisticsProviderRegistry,
    private readonly outboxService: OutboxService,
    private readonly outboxHandlers: OutboxHandlerRegistry,
    private readonly routeDistanceService: RouteDistanceService,
  ) {}

  onModuleInit(): void {
    this.outboxHandlers.register(SUBMIT_DELIVERY_EVENT_TYPE, {
      handle: (payload) => this.submit(payload.legId as string),
    });
  }

  // Idempotent: an order that already has a leg in progress keeps it.
  // Returns null only if no provider at all can take the order (in-house
  // disabled) — the order then simply waits, unassigned.
  // `options.providerKey` skips routing and sends the order to that
  // provider (an Admin forcing the in-house fallback).
  async dispatch(
    orderId: string,
    manager: EntityManager,
    legType: DeliveryLegType = DeliveryLegType.FORWARD,
    options: { providerKey?: string } = {},
  ): Promise<DeliveryLegEntity | null> {
    // Same reasoning as DeliveryEventsService.lockOrder: the check-then-
    // insert below must not interleave with another leg being created.
    await manager.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [
      orderId,
    ]);
    const legs = manager.getRepository(DeliveryLegEntity);
    const active = await legs
      .createQueryBuilder('leg')
      .where('leg."orderId" = :orderId', { orderId })
      .andWhere('leg.status IN (:...active)', { active: ACTIVE_LEG_STATUSES })
      .getOne();
    if (active) {
      return active;
    }

    const choice = options.providerKey
      ? await this.forcedChoice(orderId, legType, options.providerKey, manager)
      : await this.router.choose(orderId, legType, manager);
    if (!choice) {
      this.logger.error(
        `No logistics provider can take order ${orderId} — it will wait unassigned`,
      );
      return null;
    }

    const [{ vehicleClass }] = await manager.query<
      { vehicleClass: VehicleClass | null }[]
    >(`SELECT "vehicleClass" FROM orders WHERE id = $1`, [orderId]);
    const leg = await legs.save(
      legs.create({
        orderId,
        legType,
        providerKey: choice.provider.key,
        status: DeliveryLegStatus.REQUESTED,
        attemptNumber: choice.attemptNumber,
        vehicleClass,
      }),
    );

    if (choice.provider.capabilities.remoteSubmission) {
      await this.outboxService.enqueue(
        SUBMIT_DELIVERY_EVENT_TYPE,
        { legId: leg.id },
        manager,
      );
      return leg;
    }

    const result = await choice.provider.createDelivery(
      await this.buildRequest(leg, manager),
    );
    leg.externalId = result.externalId;
    leg.providerStatus = result.providerStatus;
    return legs.save(leg);
  }

  // A sealed bag (M5b): one leg for every parcel in it, on a courier that
  // carries bags. Idempotent like dispatch(). Returns null when no bag
  // courier can take it: the bag waits sealed and the reconciler retries.
  async dispatchBag(
    bagId: string,
    manager: EntityManager,
  ): Promise<DeliveryLegEntity | null> {
    await manager.query(`SELECT 1 FROM bags WHERE id = $1 FOR UPDATE`, [bagId]);
    const legs = manager.getRepository(DeliveryLegEntity);
    const active = await legs
      .createQueryBuilder('leg')
      .where('leg."bagId" = :bagId', { bagId })
      .andWhere('leg.status IN (:...active)', { active: ACTIVE_LEG_STATUSES })
      .getOne();
    if (active) {
      return active;
    }
    const parcels = await manager.query<
      { vehicleClass: VehicleClass | null }[]
    >(`SELECT "vehicleClass" FROM orders WHERE "bagId" = $1`, [bagId]);
    const vehicleClass = bagVehicleClass(parcels.map((p) => p.vehicleClass));
    const [{ direction }] = await manager.query<{ direction: string }[]>(
      `SELECT direction FROM bags WHERE id = $1`,
      [bagId],
    );
    const choice = await this.router.chooseForBag(bagId, vehicleClass, manager);
    if (!choice) {
      this.logger.error(
        `No courier that carries bags can take bag ${bagId} — it waits sealed`,
      );
      return null;
    }
    const leg = await legs.save(
      legs.create({
        orderId: null,
        bagId,
        // A return bag's events reach the orders as a return leg's would.
        legType:
          direction === 'return'
            ? DeliveryLegType.RETURN
            : DeliveryLegType.FORWARD,
        providerKey: choice.provider.key,
        status: DeliveryLegStatus.REQUESTED,
        attemptNumber: choice.attemptNumber,
        vehicleClass,
      }),
    );
    if (choice.provider.capabilities.remoteSubmission) {
      await this.outboxService.enqueue(
        SUBMIT_DELIVERY_EVENT_TYPE,
        { legId: leg.id },
        manager,
      );
      return leg;
    }
    const result = await choice.provider.createDelivery(
      await this.buildRequest(leg, manager),
    );
    leg.externalId = result.externalId;
    leg.providerStatus = result.providerStatus;
    leg.quotedKobo = result.quotedKobo;
    leg.trackingUrl = result.trackingUrl;
    leg.etaMinutes = result.etaMinutes;
    return legs.save(leg);
  }

  // Outbox handler for remote providers. A provider error marked
  // non-retryable (rejected request, no wallet balance, service paused)
  // ends this leg and routes the order onward — to the same provider again
  // if it allows more attempts, otherwise down the priority list (finally
  // the in-house pool). Anything else is rethrown for the outbox to retry.
  private async submit(legId: string): Promise<void> {
    const leg = await this.dataSource
      .getRepository(DeliveryLegEntity)
      .findOneBy({ id: legId });
    if (!leg || leg.status !== DeliveryLegStatus.REQUESTED || leg.externalId) {
      return; // Already submitted, or ended meanwhile — at-least-once delivery.
    }
    const provider = this.registry.get(leg.providerKey);
    if (!provider) {
      throw new Error(`No adapter registered for provider ${leg.providerKey}`);
    }

    try {
      const request = await this.buildRequest(leg, this.dataSource.manager);
      if (provider.capabilities.prepaidWallet) {
        request.otherActiveQuotedKobo = await this.otherActiveQuotedKobo(leg);
      }
      const result = await provider.createDelivery(request);
      await this.dataSource.getRepository(DeliveryLegEntity).update(leg.id, {
        externalId: result.externalId,
        providerStatus: result.providerStatus,
        quotedKobo: result.quotedKobo,
        trackingUrl: result.trackingUrl,
        etaMinutes: result.etaMinutes,
      });
      if (result.distanceMeters) {
        await this.routeDistanceService.record(
          request.pickup.nodeId,
          request.dropoff.nodeId,
          result.distanceMeters,
          leg.providerKey,
        );
      }
    } catch (error) {
      if (!(error instanceof LogisticsProviderError) || error.retryable) {
        throw error;
      }
      // A refusal can still carry the road distance (e.g. quote above the
      // cost cap) — keep it, so this route prices correctly from now on.
      if (error.measuredDistanceMeters) {
        const request = await this.buildRequest(leg, this.dataSource.manager);
        await this.routeDistanceService.record(
          request.pickup.nodeId,
          request.dropoff.nodeId,
          error.measuredDistanceMeters,
          leg.providerKey,
        );
      }
      this.logger.warn(
        `Leg ${leg.id} rejected by ${leg.providerKey}, re-routing ${leg.bagId ? `bag ${leg.bagId}` : `order ${leg.orderId}`}: ${error.message}`,
      );
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(DeliveryLegEntity).update(leg.id, {
          status: DeliveryLegStatus.CANCELLED,
          failureReason: error.message.slice(0, 500),
          endedAt: new Date(),
        });
        if (leg.bagId) {
          await this.dispatchBag(leg.bagId, manager);
        } else {
          await this.dispatch(leg.orderId!, manager, leg.legType);
        }
      });
    }
  }

  private async forcedChoice(
    orderId: string,
    legType: DeliveryLegType,
    providerKey: string,
    manager: EntityManager,
  ): Promise<RoutingChoice | null> {
    const provider = this.registry.get(providerKey);
    if (!provider) {
      return null;
    }
    const [{ count }] = await manager.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM delivery_legs
        WHERE "orderId" = $1 AND "legType" = $2`,
      [orderId, legType],
    );
    return { provider, attemptNumber: count + 1, maxCostShare: null };
  }

  private async otherActiveQuotedKobo(leg: DeliveryLegEntity): Promise<number> {
    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COALESCE(SUM("quotedKobo"), 0)::int AS total FROM delivery_legs
        WHERE "providerKey" = $1 AND id <> $2
          AND status IN ('requested', 'assigned', 'picked_up', 'returning')`,
      [leg.providerKey, leg.id],
    );
    return total;
  }

  // Pickup and drop-off are the two Nodes' counters. Deliberately carries
  // no receiver details and not the parcel description (free text that
  // may be personal) — just the tracking code the courier can match
  // against the handwritten label.
  private async buildRequest(
    leg: DeliveryLegEntity,
    manager: EntityManager,
  ): Promise<CreateDeliveryRequest> {
    if (leg.bagId) {
      return this.buildBagRequest(leg, leg.bagId, manager);
    }
    const [order] = await manager.query<
      {
        trackingCode: string;
        parcelSize: string;
        handling: string[];
        originNodeId: string;
        destinationNodeId: string;
        deliveryFeeKobo: number;
        maxCostShare: number | null;
      }[]
    >(
      `SELECT o."trackingCode", o."parcelSize", o.handling, o."originNodeId",
              o."destinationNodeId",
              o."amountKobo" + o."discountKobo" - o."destinationFeeKobo" AS "deliveryFeeKobo",
              p."maxCostShare"
         FROM orders o
         JOIN logistics_providers p ON p.key = $2
        WHERE o.id = $1`,
      [leg.orderId, leg.providerKey],
    );
    const stop = await this.stops(
      [order.originNodeId, order.destinationNodeId],
      manager,
    );
    const isReturn = leg.legType === DeliveryLegType.RETURN;

    return {
      legId: leg.id,
      trackingCode: order.trackingCode,
      pickup: stop(isReturn ? order.destinationNodeId : order.originNodeId),
      dropoff: stop(isReturn ? order.originNodeId : order.destinationNodeId),
      vehicleClass: leg.vehicleClass,
      // Size and handling flags (e.g. "fragile") are for the courier; the
      // parcel's own description stays private.
      description: `Locoomo parcel ${order.trackingCode} (${[
        order.parcelSize,
        ...order.handling,
      ].join(', ')})`,
      ...(order.maxCostShare !== null
        ? {
            maxCostKobo: Math.floor(
              Number(order.deliveryFeeKobo) * order.maxCostShare,
            ),
          }
        : {}),
    };
  }

  // A bag travels hub → destination Node as one job: the courier sees the
  // bag code and how many parcels, never what's in them. The cost cap is the
  // sum of the parcels' delivery fees, times the provider's share.
  private async buildBagRequest(
    leg: DeliveryLegEntity,
    bagId: string,
    manager: EntityManager,
  ): Promise<CreateDeliveryRequest> {
    const [bag] = await manager.query<
      {
        code: string;
        originNodeId: string;
        destinationNodeId: string;
        parcels: number;
        deliveryFeeKobo: string | null;
        maxCostShare: number | null;
      }[]
    >(
      `SELECT b.code, b."originNodeId", b."destinationNodeId",
              (SELECT count(*)::int FROM orders o WHERE o."bagId" = b.id) AS parcels,
              (SELECT sum(o."amountKobo" + o."discountKobo" - o."destinationFeeKobo")
                 FROM orders o WHERE o."bagId" = b.id) AS "deliveryFeeKobo",
              p."maxCostShare"
         FROM bags b
         JOIN logistics_providers p ON p.key = $2
        WHERE b.id = $1`,
      [bagId, leg.providerKey],
    );
    const stop = await this.stops(
      [bag.originNodeId, bag.destinationNodeId],
      manager,
    );
    return {
      legId: leg.id,
      trackingCode: bag.code,
      pickup: stop(bag.originNodeId),
      dropoff: stop(bag.destinationNodeId),
      vehicleClass: leg.vehicleClass,
      description: `Locoomo bag ${bag.code} (${bag.parcels} parcels, sealed)`,
      ...(bag.maxCostShare !== null && bag.deliveryFeeKobo !== null
        ? {
            maxCostKobo: Math.floor(
              Number(bag.deliveryFeeKobo) * bag.maxCostShare,
            ),
          }
        : {}),
    };
  }

  private async stops(
    nodeIds: string[],
    manager: EntityManager,
  ): Promise<(nodeId: string) => DeliveryStop> {
    const rows = await manager.query<StopRow[]>(
      `SELECT id AS "nodeId", name, address, city, state, latitude, longitude,
              "contactPhone"
         FROM nodes WHERE id = ANY($1)`,
      [nodeIds],
    );
    return (nodeId: string): DeliveryStop => {
      const row = rows.find((r) => r.nodeId === nodeId)!;
      return { ...row, contactName: `${row.name} (Locoomo station)` };
    };
  }
}
