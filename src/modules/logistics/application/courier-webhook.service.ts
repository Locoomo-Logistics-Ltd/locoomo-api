import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { OutboxHandlerRegistry } from '../../notifications/application/outbox-handler.registry';
import { OutboxService } from '../../notifications/application/outbox.service';
import { InvalidCourierWebhookSignatureException } from '../domain/exceptions/invalid-courier-webhook-signature.exception';
import { LogisticsInboundEventEntity } from '../infrastructure/entities/logistics-inbound-event.entity';
import { DeliveryEventsService } from './delivery-events.service';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

export const PROCESS_INBOUND_EVENT_TYPE = 'logistics.process_inbound';

// Courier webhooks, for any provider that supports them. Receiving does as
// little as possible — verify, store (deduplicated), queue — because
// couriers expect a 2xx within seconds (Sendii: 5) and redeliver otherwise.
// Processing then runs from the outbox, with retries.
@Injectable()
export class CourierWebhookService implements OnModuleInit {
  private readonly logger = new Logger(CourierWebhookService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: LogisticsProviderRegistry,
    private readonly outboxService: OutboxService,
    private readonly outboxHandlers: OutboxHandlerRegistry,
    private readonly deliveryEventsService: DeliveryEventsService,
  ) {}

  onModuleInit(): void {
    this.outboxHandlers.register(PROCESS_INBOUND_EVENT_TYPE, {
      handle: (payload) => this.process(payload.inboundEventId as string),
    });
  }

  async receive(
    providerKey: string,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<void> {
    const provider = this.registry.get(providerKey);
    if (!provider?.verifyWebhook || !provider.parseWebhook) {
      throw new EntityNotFoundException('CourierWebhook', providerKey);
    }
    if (!provider.verifyWebhook(rawBody, headers)) {
      throw new InvalidCourierWebhookSignatureException(providerKey);
    }

    const event = provider.parseWebhook(rawBody);
    if (!event.event || !event.externalId) {
      return; // A ping, or nothing about a delivery — acknowledge only.
    }

    await this.dataSource.transaction(async (manager) => {
      const [inserted] = await manager.query<{ id: string }[]>(
        `INSERT INTO logistics_inbound_events
           ("providerKey", "eventId", "externalId", payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("providerKey", "eventId") DO NOTHING
         RETURNING id`,
        [
          providerKey,
          event.eventId,
          event.externalId,
          JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>,
        ],
      );
      if (inserted) {
        await this.outboxService.enqueue(
          PROCESS_INBOUND_EVENT_TYPE,
          { inboundEventId: inserted.id },
          manager,
        );
      }
      // else: a redelivery of an event already stored — nothing to do.
    });
  }

  // Doesn't trust the webhook's own copy of the delivery when the provider
  // can be asked directly: the current state from its API is applied
  // instead (also the cure for out-of-order events). Falls back to the
  // signed payload for providers that can't be polled.
  private async process(inboundEventId: string): Promise<void> {
    const repo = this.dataSource.getRepository(LogisticsInboundEventEntity);
    const inbound = await repo.findOneBy({ id: inboundEventId });
    if (!inbound || inbound.processedAt || !inbound.externalId) {
      return;
    }
    const provider = this.registry.get(inbound.providerKey);
    if (!provider) {
      throw new Error(`No adapter registered for ${inbound.providerKey}`);
    }

    const snapshot = provider.getDelivery
      ? await provider.getDelivery(inbound.externalId)
      : provider.parseWebhook!(Buffer.from(JSON.stringify(inbound.payload)))
          .snapshot;
    await this.dataSource.transaction(async (manager) => {
      if (snapshot) {
        const applied = await this.deliveryEventsService.syncFromSnapshot(
          inbound.providerKey,
          snapshot,
          manager,
        );
        if (!applied) {
          this.logger.debug(
            `Inbound ${inbound.providerKey} event ${inbound.eventId} changed nothing`,
          );
        }
      }
      await manager
        .getRepository(LogisticsInboundEventEntity)
        .update(inbound.id, { processedAt: new Date() });
    });
  }
}
