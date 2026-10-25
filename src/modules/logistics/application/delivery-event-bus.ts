import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type {
  DeliveryEventListener,
  DeliveryEventNotice,
} from '../domain/delivery-event-notice';

// Synchronous, in-transaction fan-out of leg changes to subscribers (the
// order flow in handoffs). A listener that throws rolls the whole change
// back — the leg never moves without the order moving with it.
@Injectable()
export class DeliveryEventBus {
  private readonly listeners: DeliveryEventListener[] = [];

  subscribe(listener: DeliveryEventListener): void {
    this.listeners.push(listener);
  }

  async publish(
    notice: DeliveryEventNotice,
    manager: EntityManager,
  ): Promise<void> {
    for (const listener of this.listeners) {
      await listener.onDeliveryEvent(notice, manager);
    }
  }
}
