import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Env } from '../../config/env.validation';
import { OutboxPollerService } from './application/outbox-poller.service';
import { OutboxService } from './application/outbox.service';
import { OutboxEventEntity } from './infrastructure/entities/outbox-event.entity';
import { mailTransporterProvider } from './infrastructure/mail-transporter.provider';
import { NotificationSender } from './domain/notification-sender.port';
import { NOTIFICATION_SENDER } from './infrastructure/notification-sender.token';
import { ResendApiEmailSender } from './infrastructure/resend-api-email-sender';
import { SmtpEmailSender } from './infrastructure/smtp-email-sender';

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
    OutboxService,
    OutboxPollerService,
  ],
  // Exported so any module (identity today; orders/disputes/admin later) can
  // enqueue a best-effort notification through this service — never by
  // reaching into notifications' domain/infrastructure directly.
  exports: [OutboxService],
})
export class NotificationsModule {}
