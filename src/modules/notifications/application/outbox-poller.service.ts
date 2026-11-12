import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import { Env } from '../../../config/env.validation';
import {
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_DRAIN_ROUNDS,
  computeBackoffMs,
} from '../domain/outbox.constants';
import { OutboxEventStatus } from '../domain/outbox-event-status.enum';
import { OutboxEventEntity } from '../infrastructure/entities/outbox-event.entity';
import { OutboxHandlerRegistry } from './outbox-handler.registry';

const INTERVAL_NAME = 'outbox-poller';

@Injectable()
export class OutboxPollerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPollerService.name);
  private readonly batchSize: number;
  private readonly concurrency: number;

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
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.batchSize = configService.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.concurrency = configService.get('OUTBOX_CONCURRENCY', {
      infer: true,
    });
  }

  // Registered dynamically (not @Interval) so the period comes from config.
  // Not registered at all under NODE_ENV=test or in a PROCESS_ROLE=api
  // process — see shouldRunBackgroundJobs. Every e2e suite boots the full
  // app and several enqueue real outbox rows; tests that care about
  // delivery call poll() directly, so a timer must never also fire and
  // reach the real NotificationSender.
  onModuleInit(): void {
    if (!shouldRunBackgroundJobs(this.configService)) {
      return;
    }
    const intervalMs = this.configService.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
    const handle = setInterval(() => {
      void this.poll().catch((error: unknown) =>
        this.logger.error(
          `Outbox poll failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, handle);
  }

  onApplicationShutdown(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;

    try {
      // Keep draining while batches come back full (a backlog), bounded so
      // one tick can't run forever. Within a batch, up to `concurrency`
      // handlers run at once — the old one-at-a-time loop topped out around
      // one message per second per instance.
      for (let round = 0; round < OUTBOX_MAX_DRAIN_ROUNDS; round++) {
        const dueEvents = await this.claimDueEvents();
        await this.processConcurrently(dueEvents);
        if (dueEvents.length < this.batchSize) {
          break;
        }
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
      [OUTBOX_CLAIM_LEASE_MS, OutboxEventStatus.PENDING, this.batchSize],
    );

    // RETURNING doesn't preserve the subquery's ORDER BY.
    return rows
      .map((row) => this.outboxEvents.create(row))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // Simple worker pool over an already-claimed batch. Events are still
  // *started* in createdAt order; with concurrency > 1 they may finish out
  // of order, which is fine — every handler is independent (emails, SMS,
  // courier submissions for different orders).
  private async processConcurrently(
    events: OutboxEventEntity[],
  ): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < events.length) {
        const event = events[next++];
        await this.processEvent(event);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, events.length) }, () =>
        worker(),
      ),
    );
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
