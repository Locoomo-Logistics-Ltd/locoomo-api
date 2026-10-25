import { Injectable } from '@nestjs/common';
import type { OutboxHandler } from '../domain/outbox-handler';

// Exported from NotificationsModule. Owning modules register their handler
// once at startup (typically from an OnModuleInit hook on the handler
// provider itself — see EmailOutboxHandler), keyed by the same eventType
// string they pass to OutboxService.enqueue.
@Injectable()
export class OutboxHandlerRegistry {
  private readonly handlers = new Map<string, OutboxHandler>();

  register(eventType: string, handler: OutboxHandler): void {
    // Two modules claiming the same event type is a wiring bug — fail at
    // boot rather than silently letting whichever registered last win.
    if (this.handlers.has(eventType)) {
      throw new Error(
        `Outbox handler already registered for event type: ${eventType}`,
      );
    }
    this.handlers.set(eventType, handler);
  }

  get(eventType: string): OutboxHandler | undefined {
    return this.handlers.get(eventType);
  }
}
