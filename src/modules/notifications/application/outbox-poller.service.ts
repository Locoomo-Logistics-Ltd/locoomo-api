import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Env } from '../../../config/env.validation';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_POLL_INTERVAL_MS,
  computeBackoffMs,
} from '../domain/outbox.constants';
import { OutboxEventStatus } from '../domain/outbox-event-status.enum';
import { OutboxEventEntity } from '../infrastructure/entities/outbox-event.entity';
import { OutboxHandlerRegistry } from './outbox-handler.registry';

@Injectable()
export class OutboxPollerService {
  private readonly logger = new Logger(OutboxPollerService.name);

  // @Interval doesn't wait for one run to finish before scheduling the next
  // — skip overlapping runs in this process. Cross-process safety (more
  // than one instance) comes from claimDueEvents' SKIP LOCKED + lease, not
  // from this flag.
  private isPolling = false;

  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly outboxEvents: Repository<OutboxEventEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly handlers: OutboxHandlerRegistry,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  // Every e2e suite boots the full app, and several (register, login,
  // password-reset, email-verification, ...) now enqueue real outbox rows
  // as a side effect. e2e tests that care about delivery call `poll()`
  // directly — this timer firing on top of that would mean the real
  // NotificationSender (real SMTP creds in .env) could send mail to
  // throwaway @*.e2e.test addresses. Same skip precedent as ThrottlerModule.
  @Interval(OUTBOX_POLL_INTERVAL_MS)
  async handleInterval(): Promise<void> {
    if (this.configService.get('NODE_ENV', { infer: true }) === 'test') {
      return;
    }
    await this.poll();
  }

  async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;

    try {
      const dueEvents = await this.claimDueEvents();
      for (const event of dueEvents) {
        await this.processEvent(event);
      }
    } finally {
      this.isPolling = false;
    }
  }

  // Claims a batch in one statement: SKIP LOCKED means two instances polling
  // at the same moment take disjoint rows instead of blocking on (or both
  // reading) the same ones, and pushing nextAttemptAt out by the lease keeps
  // the claimed rows invisible to later polls while their handlers run. No
  // separate "processing" status, so a crashed instance can't strand rows —
  // they simply come due again when the lease lapses.
  private async claimDueEvents(): Promise<OutboxEventEntity[]> {
    // UPDATE ... RETURNING via manager.query resolves to a [rows, rowCount]
    // tuple (see OrdersService.transition).
    const [rows] = await this.dataSource.query<[OutboxEventEntity[], number]>(
      `UPDATE outbox_events
          SET "nextAttemptAt" = now() + ($1 * interval '1 millisecond')
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE status = $2
             AND "nextAttemptAt" <= now()
           ORDER BY "createdAt" ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [OUTBOX_CLAIM_LEASE_MS, OutboxEventStatus.PENDING, OUTBOX_BATCH_SIZE],
    );

    // RETURNING doesn't preserve the subquery's ORDER BY.
    return rows
      .map((row) => this.outboxEvents.create(row))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
    const handler = this.handlers.get(event.eventType);
    if (!handler) {
      // Not transient — retrying won't fix an event type nobody handles.
      return Promise.reject(
        new Error(`Unknown outbox event type: ${event.eventType}`),
      );
    }
    return handler.handle(event.payload);
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
