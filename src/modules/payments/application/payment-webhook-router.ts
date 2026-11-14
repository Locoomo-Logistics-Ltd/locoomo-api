import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { PaymentWebhookEvent } from '../domain/ports/payment-provider.port';

// Re-exported for handler modules (they can't import payments' domain).
export type { PaymentWebhookEvent };

// A module that takes payments of its own (merchant wallet top-ups)
// registers a handler on init. A successful charge that isn't a consumer
// payment intent is offered to each handler in turn, inside the webhook's
// transaction. Payments never imports the module behind the handler.
export interface UnmatchedChargeHandler {
  // Resolves true if the charge was recognised (whether or not it was new).
  handle(event: PaymentWebhookEvent, manager: EntityManager): Promise<boolean>;
}

@Injectable()
export class PaymentWebhookRouter {
  private readonly handlers: UnmatchedChargeHandler[] = [];

  register(handler: UnmatchedChargeHandler): void {
    this.handlers.push(handler);
  }

  async route(
    event: PaymentWebhookEvent,
    manager: EntityManager,
  ): Promise<boolean> {
    for (const handler of this.handlers) {
      if (await handler.handle(event, manager)) {
        return true;
      }
    }
    return false;
  }
}
