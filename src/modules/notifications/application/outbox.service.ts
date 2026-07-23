import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EmailMessage } from '../domain/email-message';
import { OutboxEventEntity } from '../infrastructure/entities/outbox-event.entity';

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
    const repo = manager
      ? manager.getRepository(OutboxEventEntity)
      : this.outboxEvents;

    return repo.save(
      repo.create({
        eventType: 'email',
        payload: message as unknown as Record<string, unknown>,
      }),
    );
  }
}
