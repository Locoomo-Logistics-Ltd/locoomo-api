import type { EntityManager } from 'typeorm';
import { DeliveryEventType, DeliveryLegType } from './delivery-leg';

// What logistics tells the rest of the system when a leg changes — after
// the leg itself is updated, inside the same transaction. The order flow
// (handoffs) subscribes to this instead of logistics calling into it, so
// the dependency only runs one way.
export interface DeliveryEventNotice {
  orderId: string;
  legId: string;
  legType: DeliveryLegType;
  providerKey: string;
  event: DeliveryEventType;
  // Set for in-house riders (their user id) — whose capacity slot to hold
  // or release; null for external couriers.
  courierUserId: string | null;
  // Why the leg ended or was released, when known (e.g. a provider's
  // cancel reason, or 'assign_timeout').
  reason: string | null;
}

export interface DeliveryEventListener {
  onDeliveryEvent(
    notice: DeliveryEventNotice,
    manager: EntityManager,
  ): Promise<void>;
}
