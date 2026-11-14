import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { OutboxHandler } from '../domain/outbox-handler';
import type { SmsMessage, SmsSender } from '../domain/sms';
import { SMS_SENDER } from '../infrastructure/sms-sender.token';
import { OutboxHandlerRegistry } from './outbox-handler.registry';

export const SMS_OUTBOX_EVENT_TYPE = 'sms';

@Injectable()
export class SmsOutboxHandler implements OutboxHandler, OnModuleInit {
  private readonly logger = new Logger(SmsOutboxHandler.name);

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    @Inject(SMS_SENDER) private readonly sender: SmsSender,
  ) {}

  onModuleInit(): void {
    this.registry.register(SMS_OUTBOX_EVENT_TYPE, this);
  }

  // A `skipped` result completes the outbox row (no retry) — SMS is
  // best-effort by design. Only transient provider errors throw.
  async handle(payload: Record<string, unknown>): Promise<void> {
    const message = payload as unknown as SmsMessage;
    const result = await this.sender.send(message);
    if (result.status === 'skipped') {
      this.logger.debug(
        `SMS${message.tag ? ` (${message.tag})` : ''} skipped: ${result.reason}`,
      );
    }
  }
}
