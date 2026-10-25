import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EmailMessage } from '../domain/email-message';
import type { NotificationSender } from '../domain/notification-sender.port';
import type { OutboxHandler } from '../domain/outbox-handler';
import { NOTIFICATION_SENDER } from '../infrastructure/notification-sender.token';
import { OutboxHandlerRegistry } from './outbox-handler.registry';

export const EMAIL_OUTBOX_EVENT_TYPE = 'email';

@Injectable()
export class EmailOutboxHandler implements OutboxHandler, OnModuleInit {
  constructor(
    private readonly registry: OutboxHandlerRegistry,
    @Inject(NOTIFICATION_SENDER)
    private readonly notificationSender: NotificationSender,
  ) {}

  onModuleInit(): void {
    this.registry.register(EMAIL_OUTBOX_EVENT_TYPE, this);
  }

  handle(payload: Record<string, unknown>): Promise<void> {
    return this.notificationSender.sendEmail(
      payload as unknown as EmailMessage,
    );
  }
}
