import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EmailMessage } from '../domain/email-message';
import { OutboxEventEntity } from '../infrastructure/entities/outbox-event.entity';
import { EMAIL_OUTBOX_EVENT_TYPE } from './email-outbox.handler';

@Injectable()
export class OutboxService {
  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly outboxEvents: Repository<OutboxEventEntity>,
  ) {}

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
