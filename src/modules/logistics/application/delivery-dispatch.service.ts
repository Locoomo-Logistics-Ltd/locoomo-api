import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxHandlerRegistry } from '../../notifications/application/outbox-handler.registry';
import { OutboxService } from '../../notifications/application/outbox.service';
import {
  ACTIVE_LEG_STATUSES,
  DeliveryLegStatus,
  DeliveryLegType,
} from '../domain/delivery-leg';
import {
  CreateDeliveryRequest,
  DeliveryStop,
  LogisticsProviderError,
} from '../domain/ports/logistics-provider.port';
import { DeliveryLegEntity } from '../infrastructure/entities/delivery-leg.entity';
import { LogisticsProviderRegistry } from './logistics-provider.registry';
import { LogisticsRouterService } from './logistics-router.service';

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
  ) {}

  onModuleInit(): void {
    this.outboxHandlers.register(SUBMIT_DELIVERY_EVENT_TYPE, {
      handle: (payload) => this.submit(payload.legId as string),
    });
  }

  // Idempotent: an order that already has a leg in progress keeps it.
  // Returns null only if no provider at all can take the order (in-house
  // disabled) — the order then simply waits, unassigned.
  async dispatch(
    orderId: string,
    manager: EntityManager,
    legType: DeliveryLegType = DeliveryLegType.FORWARD,
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

    const choice = await this.router.choose(orderId, legType, manager);
    if (!choice) {
      this.logger.error(
        `No logistics provider can take order ${orderId} — it will wait unassigned`,
      );
      return null;
    }

    const leg = await legs.save(
      legs.create({
        orderId,
        legType,
        providerKey: choice.provider.key,
        status: DeliveryLegStatus.REQUESTED,
        attemptNumber: choice.attemptNumber,
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
      const result = await provider.createDelivery(
        await this.buildRequest(leg, this.dataSource.manager),
      );
      await this.dataSource.getRepository(DeliveryLegEntity).update(leg.id, {
        externalId: result.externalId,
        providerStatus: result.providerStatus,
        quotedKobo: result.quotedKobo,
        trackingUrl: result.trackingUrl,
      });
    } catch (error) {
      if (!(error instanceof LogisticsProviderError) || error.retryable) {
        throw error;
      }
      this.logger.warn(
        `Leg ${leg.id} rejected by ${leg.providerKey}, re-routing order ${leg.orderId}: ${error.message}`,
      );
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(DeliveryLegEntity).update(leg.id, {
          status: DeliveryLegStatus.CANCELLED,
          failureReason: error.message.slice(0, 500),
          endedAt: new Date(),
        });
        await this.dispatch(leg.orderId, manager, leg.legType);
      });
    }
  }

  // Pickup and drop-off are the two Nodes' counters. Deliberately carries
  // no receiver details and not the parcel description (free text that
  // may be personal) — just the tracking code the courier can match
  // against the handwritten label.
  private async buildRequest(
    leg: DeliveryLegEntity,
    manager: EntityManager,
  ): Promise<CreateDeliveryRequest> {
    const [order] = await manager.query<
      {
        trackingCode: string;
        parcelSize: string;
        originNodeId: string;
        destinationNodeId: string;
      }[]
    >(
      `SELECT "trackingCode", "parcelSize", "originNodeId", "destinationNodeId"
         FROM orders WHERE id = $1`,
      [leg.orderId],
    );
    const stops = await manager.query<StopRow[]>(
      `SELECT id AS "nodeId", name, address, city, state, latitude, longitude,
              "contactPhone"
         FROM nodes WHERE id = ANY($1)`,
      [[order.originNodeId, order.destinationNodeId]],
    );
    const stop = (nodeId: string): DeliveryStop => {
      const row = stops.find((s) => s.nodeId === nodeId)!;
      return { ...row, contactName: `${row.name} (Locoomo station)` };
    };
    const isReturn = leg.legType === DeliveryLegType.RETURN;

    return {
      legId: leg.id,
      trackingCode: order.trackingCode,
      pickup: stop(isReturn ? order.destinationNodeId : order.originNodeId),
      dropoff: stop(isReturn ? order.originNodeId : order.destinationNodeId),
      vehicleClass: leg.vehicleClass,
      description: `Locoomo parcel ${order.trackingCode} (${order.parcelSize})`,
    };
  }
}
