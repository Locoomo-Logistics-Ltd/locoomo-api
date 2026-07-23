import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { EmailMessage } from '../domain/email-message';
import type { NotificationSender } from '../domain/notification-sender.port';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_POLL_INTERVAL_MS,
  computeBackoffMs,
} from '../domain/outbox.constants';
import { OutboxEventStatus } from '../domain/outbox-event-status.enum';
import { OutboxEventEntity } from '../infrastructure/entities/outbox-event.entity';
import { NOTIFICATION_SENDER } from '../infrastructure/notification-sender.token';

@Injectable()
export class OutboxPollerService {
  private readonly logger = new Logger(OutboxPollerService.name);

  // @Interval doesn't wait for one run to finish before scheduling the next
  // — if a poll ever takes longer than the interval (a slow SMTP call), two
  // overlapping runs could pick up and double-send the same row. Single
  // in-process instance today, so this flag is enough; a DB-level lock
  // (SELECT ... FOR UPDATE SKIP LOCKED) is the next step if this ever runs
  // as more than one instance.
  private isPolling = false;

  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly outboxEvents: Repository<OutboxEventEntity>,
    @Inject(NOTIFICATION_SENDER)
    private readonly notificationSender: NotificationSender,
  ) {}

  @Interval(OUTBOX_POLL_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;

    try {
      const dueEvents = await this.outboxEvents.find({
        where: {
          status: OutboxEventStatus.PENDING,
          nextAttemptAt: LessThanOrEqual(new Date()),
        },
        order: { createdAt: 'ASC' },
        take: OUTBOX_BATCH_SIZE,
      });

      for (const event of dueEvents) {
        await this.processEvent(event);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async processEvent(event: OutboxEventEntity): Promise<void> {
    try {
      await this.dispatch(event);
      event.status = OutboxEventStatus.SENT;
      event.processedAt = new Date();
      event.lastError = null;
      await this.outboxEvents.save(event);
    } catch (error) {
      await this.registerFailure(event, error);
    }
  }

  private dispatch(event: OutboxEventEntity): Promise<void> {
    if (event.eventType === 'email') {
      return this.notificationSender.sendEmail(
        event.payload as unknown as EmailMessage,
      );
    }
    // Not transient — retrying won't fix an event type nobody handles.
    return Promise.reject(
      new Error(`Unknown outbox event type: ${event.eventType}`),
    );
  }

  private async registerFailure(
    event: OutboxEventEntity,
    error: unknown,
  ): Promise<void> {
    event.attempts += 1;
    event.lastError = error instanceof Error ? error.message : String(error);

    if (event.attempts >= OUTBOX_MAX_ATTEMPTS) {
      event.status = OutboxEventStatus.FAILED;
      this.logger.error(
        `Outbox event ${event.id} (${event.eventType}) failed permanently after ${event.attempts} attempts: ${event.lastError}`,
      );
    } else {
      event.nextAttemptAt = new Date(
        Date.now() + computeBackoffMs(event.attempts),
      );
      this.logger.warn(
        `Outbox event ${event.id} (${event.eventType}) failed attempt ${event.attempts}, retrying at ${event.nextAttemptAt.toISOString()}: ${event.lastError}`,
      );
    }

    await this.outboxEvents.save(event);
  }
}
