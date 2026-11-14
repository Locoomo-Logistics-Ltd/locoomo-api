import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ShipmentEventType } from '../domain/shipment';
import { MerchantShipmentEventEntity } from '../infrastructure/entities/merchant-shipment-event.entity';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';

export interface RecordedShipmentEvent {
  event: MerchantShipmentEventEntity;
  // The shipment as saved with this change (webhooks carry the whole
  // object as it was at that moment).
  shipment: MerchantShipmentEntity;
  // Never stored on the event row: handed to listeners only (webhook relay
  // of the collection code, notifyReceiver merchant/both).
  secrets?: { collectionCode?: string };
}

// Runs inside the change's transaction, so whatever a listener writes
// (webhook events, M2d) commits or rolls back with it.
export type ShipmentEventListener = (
  recorded: RecordedShipmentEvent,
  manager: EntityManager,
) => Promise<void>;

// Every shipment change goes through here: bump `sequence`, save, append
// the event (timeline), tell listeners.
@Injectable()
export class ShipmentEventsService {
  private readonly listeners: ShipmentEventListener[] = [];

  addListener(listener: ShipmentEventListener): void {
    this.listeners.push(listener);
  }

  async apply(
    manager: EntityManager,
    shipment: MerchantShipmentEntity,
    type: ShipmentEventType,
    options: {
      nodeName?: string | null;
      data?: Record<string, unknown> | null;
      secrets?: RecordedShipmentEvent['secrets'];
      // Creation saves the shipment itself at sequence 1.
      bump?: boolean;
    } = {},
  ): Promise<MerchantShipmentEntity> {
    if (options.bump ?? true) {
      shipment.sequence += 1;
    }
    const saved = await manager.save(MerchantShipmentEntity, shipment);
    const event = await manager.save(
      manager.create(MerchantShipmentEventEntity, {
        shipmentId: saved.id,
        merchantId: saved.merchantId,
        mode: saved.mode,
        sequence: saved.sequence,
        type,
        nodeName: options.nodeName ?? null,
        data: options.data ?? null,
      }),
    );
    for (const listener of this.listeners) {
      await listener(
        { event, shipment: saved, secrets: options.secrets },
        manager,
      );
    }
    return saved;
  }
}
