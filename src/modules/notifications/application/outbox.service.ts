import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { toE164 } from '../../../common/phone/phone-number';
import { EmailMessage } from '../domain/email-message';
import type { SmsMessage, SmsSender } from '../domain/sms';
import { OutboxEventEntity } from '../infrastructure/entities/outbox-event.entity';
import { SMS_SENDER } from '../infrastructure/sms-sender.token';
import { EMAIL_OUTBOX_EVENT_TYPE } from './email-outbox.handler';
import { SMS_OUTBOX_EVENT_TYPE } from './sms-outbox.handler';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly outboxEvents: Repository<OutboxEventEntity>,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
  ) {}

  // Whether an SMS queued now would actually be attempted. Flows use this to
  // decide whether they need another channel (plan D10/D19) — e.g. a
  // receiver with no email and SMS off can't be notified at all.
  isSmsEnabled(): boolean {
    return this.smsSender.isEnabled();
  }

  // Best-effort SMS (plan D10): returns null — and queues nothing — when SMS
  // is disabled or the number isn't a valid phone number, so callers never
  // have to branch; they just also send an email/webhook as appropriate.
  async enqueueSms(
    message: SmsMessage,
    manager?: EntityManager,
  ): Promise<OutboxEventEntity | null> {
    if (!this.smsSender.isEnabled()) {
      return null;
    }
    const to = toE164(message.to);
    if (!to) {
      this.logger.warn(
        `Not queueing SMS${message.tag ? ` (${message.tag})` : ''}: invalid phone number`,
      );
      return null;
    }
    return this.enqueue(
      SMS_OUTBOX_EVENT_TYPE,
      { to, body: message.body, tag: message.tag ?? null },
      manager,
    );
  }

  // Pass the caller's EntityManager when this enqueue must be atomic with a
  // state change (e.g. issuing a password-reset token) — the whole point of
  // the transactional outbox pattern is that the notification is queued if
  // and only if the state change actually committed. Without one, this opens
  // its own implicit transaction (fine for a standalone enqueue).
  async enqueueEmail(
    message: EmailMessage,
    manager?: EntityManager,
  ): Promise<OutboxEventEntity> {
    return this.enqueue(
      EMAIL_OUTBOX_EVENT_TYPE,
      message as unknown as Record<string, unknown>,
      manager,
    );
  }

  // Generic entry point for any module's own event type — the caller must
  // also register an OutboxHandler for `eventType` (OutboxHandlerRegistry),
  // otherwise the poller fails the row as an unknown type.
  async enqueue(
    eventType: string,
    payload: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<OutboxEventEntity> {
    const repo = manager
      ? manager.getRepository(OutboxEventEntity)
      : this.outboxEvents;

    return repo.save(repo.create({ eventType, payload }));
  }
}
