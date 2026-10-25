import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { Env } from '../../src/config/env.validation';
import { OutboxHandlerRegistry } from '../../src/modules/notifications/application/outbox-handler.registry';
import { OutboxPollerService } from '../../src/modules/notifications/application/outbox-poller.service';
import { OutboxService } from '../../src/modules/notifications/application/outbox.service';
import { EmailMessage } from '../../src/modules/notifications/domain/email-message';
import { OutboxEventStatus } from '../../src/modules/notifications/domain/outbox-event-status.enum';
import { NotificationSender } from '../../src/modules/notifications/domain/notification-sender.port';
import { OutboxEventEntity } from '../../src/modules/notifications/infrastructure/entities/outbox-event.entity';
import { NOTIFICATION_SENDER } from '../../src/modules/notifications/infrastructure/notification-sender.token';

class FakeNotificationSender implements NotificationSender {
  sentMessages: EmailMessage[] = [];
  shouldFail = false;

  sendEmail(message: EmailMessage): Promise<void> {
    if (this.shouldFail) {
      return Promise.reject(new Error('simulated send failure'));
    }
    this.sentMessages.push(message);
    return Promise.resolve();
  }
}

describe('Outbox / notification poller (e2e)', () => {
  let app: INestApplication;
  let outboxService: OutboxService;
  let poller: OutboxPollerService;
  let outboxEvents: Repository<OutboxEventEntity>;
  let fakeSender: FakeNotificationSender;
  let registry: OutboxHandlerRegistry;
  let dataSource: DataSource;
  let configService: ConfigService<Env, true>;
  const createdIds: string[] = [];

  beforeAll(async () => {
    fakeSender = new FakeNotificationSender();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NOTIFICATION_SENDER)
      .useValue(fakeSender)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    outboxService = moduleFixture.get(OutboxService);
    poller = moduleFixture.get(OutboxPollerService);
    outboxEvents = moduleFixture.get(getRepositoryToken(OutboxEventEntity));
    registry = moduleFixture.get(OutboxHandlerRegistry);
    dataSource = moduleFixture.get(DataSource);
    configService = moduleFixture.get(ConfigService);

    // Other e2e suites (register, password reset, ...) enqueue real rows
    // against this same table and never drain them — the automatic
    // @Interval poll is disabled in test env specifically so it doesn't hit
    // real SMTP. This suite makes precise, order-dependent assertions about
    // exactly what a poll() picks up, so it needs to own an empty queue.
    await outboxEvents.clear();
  });

  beforeEach(() => {
    fakeSender.sentMessages = [];
    fakeSender.shouldFail = false;
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await outboxEvents.delete(createdIds);
    }
    await app.close();
  });

  it('delivers a queued email and marks the row sent', async () => {
    const created = await outboxService.enqueueEmail({
      to: 'happy-path@outbox.e2e.test',
      subject: 'Welcome',
      text: 'Hello',
    });
    createdIds.push(created.id);

    await poller.poll();

    expect(fakeSender.sentMessages).toContainEqual(
      expect.objectContaining({ to: 'happy-path@outbox.e2e.test' }),
    );

    const stored = await outboxEvents.findOneByOrFail({ id: created.id });
    expect(stored.status).toBe(OutboxEventStatus.SENT);
    expect(stored.processedAt).not.toBeNull();
  });

  it('backs off on failure instead of retrying immediately', async () => {
    fakeSender.shouldFail = true;

    const created = await outboxService.enqueueEmail({
      to: 'backoff@outbox.e2e.test',
      subject: 'Will fail once',
    });
    createdIds.push(created.id);

    await poller.poll();

    let stored = await outboxEvents.findOneByOrFail({ id: created.id });
    expect(stored.status).toBe(OutboxEventStatus.PENDING);
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.lastError).toContain('simulated send failure');

    // Backoff pushed nextAttemptAt into the future — an immediate second
    // poll must not touch it again.
    fakeSender.shouldFail = false;
    await poller.poll();

    stored = await outboxEvents.findOneByOrFail({ id: created.id });
    expect(stored.status).toBe(OutboxEventStatus.PENDING);
    expect(stored.attempts).toBe(1);
  });

  it('gives up permanently after the max attempt count', async () => {
    fakeSender.shouldFail = true;

    const created = await outboxService.enqueueEmail({
      to: 'give-up@outbox.e2e.test',
      subject: 'Always fails',
    });
    createdIds.push(created.id);

    let stored = await outboxEvents.findOneByOrFail({ id: created.id });

    // Force each retry to be due immediately instead of waiting out real
    // backoff delays — proves the attempt-counting/terminal-state logic,
    // not the timer.
    while (stored.status === OutboxEventStatus.PENDING) {
      await outboxEvents.update(stored.id, { nextAttemptAt: new Date(0) });
      await poller.poll();
      stored = await outboxEvents.findOneByOrFail({ id: created.id });
    }

    expect(stored.status).toBe(OutboxEventStatus.FAILED);
    expect(stored.attempts).toBe(5);
  });

  it('does not double-send when two polls overlap', async () => {
    const created = await outboxService.enqueueEmail({
      to: 'concurrent@outbox.e2e.test',
      subject: 'Only once',
    });
    createdIds.push(created.id);

    await Promise.all([poller.poll(), poller.poll()]);

    const sentCount = fakeSender.sentMessages.filter(
      (message) => message.to === 'concurrent@outbox.e2e.test',
    ).length;
    expect(sentCount).toBe(1);
  });

  it('delivers a non-email event type through its registered handler', async () => {
    const handled: Record<string, unknown>[] = [];
    registry.register('test.custom', {
      handle: (payload) => {
        handled.push(payload);
        return Promise.resolve();
      },
    });

    const created = await outboxService.enqueue('test.custom', {
      orderId: 'abc',
    });
    createdIds.push(created.id);

    await poller.poll();

    expect(handled).toEqual([{ orderId: 'abc' }]);
    const stored = await outboxEvents.findOneByOrFail({ id: created.id });
    expect(stored.status).toBe(OutboxEventStatus.SENT);
  });

  it('rejects registering two handlers for the same event type', () => {
    const handler = { handle: () => Promise.resolve() };
    registry.register('test.duplicate', handler);
    expect(() => registry.register('test.duplicate', handler)).toThrow(
      /already registered/,
    );
  });

  it('counts an event type with no handler as a failed attempt', async () => {
    const created = await outboxService.enqueue('test.nobody-handles-this', {});
    createdIds.push(created.id);

    await poller.poll();

    const stored = await outboxEvents.findOneByOrFail({ id: created.id });
    expect(stored.status).toBe(OutboxEventStatus.PENDING);
    expect(stored.attempts).toBe(1);
    expect(stored.lastError).toContain('Unknown outbox event type');
  });

  it('does not hand the same row to a second instance while a handler is still running', async () => {
    // A separate poller instance stands in for a second app process — it
    // has its own in-memory isPolling flag, so only the database claim
    // (SKIP LOCKED + lease) can stop it picking up the in-flight row.
    const secondInstance = new OutboxPollerService(
      outboxEvents,
      dataSource,
      registry,
      configService,
    );

    let calls = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    registry.register('test.slow', {
      handle: async () => {
        calls += 1;
        markStarted();
        await released;
      },
    });

    const created = await outboxService.enqueue('test.slow', {});
    createdIds.push(created.id);

    const firstPoll = poller.poll();
    await started;
    await secondInstance.poll();
    expect(calls).toBe(1);

    release();
    await firstPoll;

    const stored = await outboxEvents.findOneByOrFail({ id: created.id });
    expect(stored.status).toBe(OutboxEventStatus.SENT);
    expect(calls).toBe(1);
  });
});
