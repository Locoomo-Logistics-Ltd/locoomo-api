import { Injectable, OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { NodesService } from '../../nodes/application/nodes.service';
import {
  OrderStatusChanged,
  OrderStatusEventBus,
  OrderStatusListener,
} from '../../orders/application/order-status-event-bus';

// Statuses (orders' own values, compared as strings) at which a parcel
// starts or stops occupying its destination Node.
// Held from drop-off: a courier is dispatched towards the destination.
const HOLD_ON = new Set(['parcel_received_at_origin']);
// Released once it's off the destination side for good: collected, gone
// back (a failed delivery or a return picked up from the shelf both pass
// through return_in_transit), or cancelled.
const RELEASE_ON = new Set(['completed', 'return_in_transit', 'cancelled']);

// The destination counter of two-counter capacity (plan §5.2, E3), driven
// by order status changes inside the transaction that made them. The
// orders.destinationSlotHeld flag makes hold/release idempotent, so a
// courier released and re-dispatched never holds two slots.
@Injectable()
export class DestinationCapacitySubscriber
  implements OrderStatusListener, OnModuleInit
{
  constructor(
    private readonly bus: OrderStatusEventBus,
    private readonly nodes: NodesService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this);
  }

  async onOrderStatusChanged(
    change: OrderStatusChanged,
    manager: EntityManager,
  ): Promise<void> {
    if (HOLD_ON.has(change.toStatus)) {
      const node = await this.flip(manager, change.orderId, true);
      if (node) {
        await this.nodes.holdDestinationSlot(node, manager);
      }
    } else if (RELEASE_ON.has(change.toStatus)) {
      const node = await this.flip(manager, change.orderId, false);
      if (node) {
        await this.nodes.releaseDestinationSlot(node, manager);
      }
    }
  }

  // Sets the flag if it isn't already; returns the destination Node only
  // when it actually changed.
  private async flip(
    manager: EntityManager,
    orderId: string,
    held: boolean,
  ): Promise<string | null> {
    const [rows] = await manager.query<
      [{ destinationNodeId: string }[], number]
    >(
      `UPDATE orders SET "destinationSlotHeld" = $2
        WHERE id = $1 AND "destinationSlotHeld" = $3
        RETURNING "destinationNodeId"`,
      [orderId, held, !held],
    );
    return rows[0]?.destinationNodeId ?? null;
  }
}
