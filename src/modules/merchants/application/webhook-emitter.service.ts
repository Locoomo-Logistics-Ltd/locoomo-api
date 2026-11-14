import { Injectable, OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ApiKeyMode } from '../domain/api-key';
import { newWebhookMessageId, WebhookEventType } from '../domain/webhooks';
import { WebhookDeliveryEntity } from '../infrastructure/entities/webhook-delivery.entity';
import { WebhookEndpointEntity } from '../infrastructure/entities/webhook-endpoint.entity';
import { WebhookEventEntity } from '../infrastructure/entities/webhook-event.entity';
import {
  RecordedShipmentEvent,
  ShipmentEventsService,
} from './shipment-events.service';
import { shipmentView } from './shipment-view';

export interface EmitInput {
  merchantId: string;
  mode: ApiKeyMode;
  type: WebhookEventType;
  data: Record<string, unknown>;
  occurredAt?: Date;
  // Deliver to this endpoint only (send test event).
  onlyEndpointId?: string;
}

// Turns changes into webhook events (MERCHANT_API.md §12.2) and queues one
// delivery per subscribed endpoint, inside the change's own transaction:
// an event exists if and only if the change committed.
@Injectable()
export class WebhookEmitterService implements OnModuleInit {
  constructor(private readonly shipmentEvents: ShipmentEventsService) {}

  onModuleInit(): void {
    this.shipmentEvents.addListener((recorded, manager) =>
      this.fromShipmentEvent(recorded, manager),
    );
  }

  async emit(manager: EntityManager, input: EmitInput): Promise<string> {
    const id = newWebhookMessageId();
    const occurredAt = (input.occurredAt ?? new Date()).toISOString();
    const body = JSON.stringify({
      id,
      type: input.type,
      version: 1,
      mode: input.mode,
      occurredAt,
      data: input.data,
    });
    await manager.insert(WebhookEventEntity, {
      id,
      merchantId: input.merchantId,
      mode: input.mode,
      type: input.type,
      body,
    });

    const endpoints = input.onlyEndpointId
      ? await manager.findBy(WebhookEndpointEntity, {
          id: input.onlyEndpointId,
          merchantId: input.merchantId,
        })
      : await manager
          .getRepository(WebhookEndpointEntity)
          .createQueryBuilder('e')
          .where('e."merchantId" = :merchantId AND e.mode = :mode', input)
          .andWhere('e.enabled = true')
          .andWhere(`(cardinality(e.events) = 0 OR :type = ANY(e.events))`, {
            type: input.type,
          })
          .getMany();
    if (endpoints.length > 0) {
      const now = new Date();
      await manager.insert(
        WebhookDeliveryEntity,
        endpoints.map((endpoint) => ({
          eventId: id,
          endpointId: endpoint.id,
          merchantId: input.merchantId,
          status: 'pending' as const,
          attempts: 0,
          nextAttemptAt: now,
        })),
      );
    }
    return id;
  }

  // Account status changes go to both modes: integrations listen in test
  // while waiting for approval, then in live.
  async merchantStatusChanged(
    manager: EntityManager,
    merchantId: string,
    previousStatus: string,
    status: string,
  ): Promise<void> {
    for (const mode of ['test', 'live'] as const) {
      await this.emit(manager, {
        merchantId,
        mode,
        type: 'merchant.status_changed',
        data: { merchant: { id: merchantId, status, previousStatus } },
      });
    }
  }

  private async fromShipmentEvent(
    { event, shipment, secrets }: RecordedShipmentEvent,
    manager: EntityManager,
  ): Promise<void> {
    const data: Record<string, unknown> = {
      shipment: shipmentView(shipment),
      sequence: shipment.sequence,
    };
    // notifyReceiver merchant/both: the code exists only in the event
    // (§11.1), never on the shipment.
    if (secrets?.collectionCode) {
      data.collectionCode = secrets.collectionCode;
    }
    if (event.data?.adjustment) {
      data.adjustment = event.data.adjustment;
    }
    if (event.data?.previousDestination) {
      data.previousDestination = event.data.previousDestination;
    }
    if (event.type === 'updated' && event.data?.changed) {
      data.changed = event.data.changed;
    }
    await this.emit(manager, {
      merchantId: shipment.merchantId,
      mode: shipment.mode,
      type: `shipment.${event.type}` as WebhookEventType,
      data,
      occurredAt: event.createdAt,
    });
  }
}
