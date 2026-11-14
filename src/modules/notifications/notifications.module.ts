import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../../config/env.validation';
import { EmailOutboxHandler } from './application/email-outbox.handler';
import { OutboxHandlerRegistry } from './application/outbox-handler.registry';
import { OutboxPollerService } from './application/outbox-poller.service';
import { OutboxService } from './application/outbox.service';
import { OutboxEventEntity } from './infrastructure/entities/outbox-event.entity';
import { mailTransporterProvider } from './infrastructure/mail-transporter.provider';
import { NotificationSender } from './domain/notification-sender.port';
import { NOTIFICATION_SENDER } from './infrastructure/notification-sender.token';
import { ResendApiEmailSender } from './infrastructure/resend-api-email-sender';
import { SmtpEmailSender } from './infrastructure/smtp-email-sender';
import { SmsOutboxHandler } from './application/sms-outbox.handler';
import type { SmsSender } from './domain/sms';
import { NoopSmsSender } from './infrastructure/noop-sms-sender';
import { SMS_SENDER } from './infrastructure/sms-sender.token';
import { TermiiSmsSender } from './infrastructure/termii-sms-sender';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutboxEventEntity]),
    ScheduleModule.forRoot(),
  ],
  providers: [
    mailTransporterProvider,
    SmtpEmailSender,
    ResendApiEmailSender,
    {
      provide: NOTIFICATION_SENDER,
      // EMAIL_TRANSPORT toggle — see env.validation.ts. Picks the concrete
      // adapter once at module init rather than branching per-send, so the
      // rest of the app (OutboxPollerService) stays oblivious to which
      // transport is active.
      useFactory: (
        configService: ConfigService<Env, true>,
        smtpSender: SmtpEmailSender,
        resendApiSender: ResendApiEmailSender,
      ): NotificationSender =>
        configService.get('EMAIL_TRANSPORT', { infer: true }) === 'resend_api'
          ? resendApiSender
          : smtpSender,
      inject: [ConfigService, SmtpEmailSender, ResendApiEmailSender],
    },
    {
      provide: SMS_SENDER,
      // Plan D10: SMS is optional. No provider or no key → a no-op sender,
      // and every flow carries on with its other channels. A key the
      // provider rejects disables SMS at the first send (TermiiSmsSender).
      useFactory: (config: ConfigService<Env, true>): SmsSender => {
        const provider = config.get('SMS_PROVIDER', { infer: true });
        const apiKey = config.get('SMS_API_KEY', { infer: true });
        if (provider === 'none') {
          return new NoopSmsSender('SMS_PROVIDER=none');
        }
        if (!apiKey) {
          return new NoopSmsSender(
            `SMS_PROVIDER=${provider} but no SMS_API_KEY`,
          );
        }
        return new TermiiSmsSender({
          apiKey,
          baseUrl: config.get('TERMII_BASE_URL', { infer: true }),
          senderId: config.get('SMS_SENDER_ID', { infer: true }),
          channel: config.get('TERMII_CHANNEL', { infer: true }),
        });
      },
      inject: [ConfigService],
    },
    OutboxService,
    OutboxHandlerRegistry,
    EmailOutboxHandler,
    SmsOutboxHandler,
    OutboxPollerService,
  ],
  // Exported so any module (identity today; orders/disputes/admin later) can
  // enqueue a best-effort notification through this service — never by
  // reaching into notifications' domain/infrastructure directly.
  // OutboxHandlerRegistry is exported so a module with its own event type
  // can register the handler that delivers it (see OutboxHandler).
  exports: [OutboxService, OutboxHandlerRegistry],
})
export class NotificationsModule {}
