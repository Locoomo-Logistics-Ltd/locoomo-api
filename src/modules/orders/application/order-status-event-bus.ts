import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

// What the orders module tells the rest of the system whenever an order's
// status changes — published by OrdersService *inside* the transaction that
// changed it (plan §5.6, decision E5). Subscribers (merchant shipment
// mirroring + webhooks, notifications, capacity counters) run in that same
// transaction: if one throws, the status change rolls back with it, so a
// status can never move without its side effects being recorded.
//
// Lives in application/ (not domain/) on purpose: other modules may import
// application files under the boundary rules, and statuses are plain
// strings here so subscribers don't depend on orders' domain enums.
export interface OrderStatusChanged {
  orderId: string;
  trackingCode: string;
  // null for the order's creation.
  fromStatus: string | null;
  toStatus: string;
  // The order_events type recorded for this change (e.g.
  // 'parcel_received_at_origin', 'courier_released').
  eventType: string;
  occurredAt: Date;
  // Who sent it: 'consumer' or 'merchant' (then merchantId is set), so a
  // subscriber can ignore orders that aren't its business without a query.
  source: string;
  merchantId: string | null;
}

export interface OrderStatusListener {
  onOrderStatusChanged(
    change: OrderStatusChanged,
    manager: EntityManager,
  ): Promise<void>;
}

@Injectable()
export class OrderStatusEventBus {
  private readonly listeners: OrderStatusListener[] = [];

  subscribe(listener: OrderStatusListener): void {
    this.listeners.push(listener);
  }

  async publish(
    change: OrderStatusChanged,
    manager: EntityManager,
  ): Promise<void> {
    for (const listener of this.listeners) {
      await listener.onOrderStatusChanged(change, manager);
    }
  }
}
