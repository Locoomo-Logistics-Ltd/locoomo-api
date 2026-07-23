import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxPollerService } from './application/outbox-poller.service';
import { OutboxService } from './application/outbox.service';
import { OutboxEventEntity } from './infrastructure/entities/outbox-event.entity';
import { mailTransporterProvider } from './infrastructure/mail-transporter.provider';
import { NOTIFICATION_SENDER } from './infrastructure/notification-sender.token';
import { SmtpEmailSender } from './infrastructure/smtp-email-sender';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutboxEventEntity]),
    ScheduleModule.forRoot(),
  ],
  providers: [
    mailTransporterProvider,
    { provide: NOTIFICATION_SENDER, useClass: SmtpEmailSender },
    OutboxService,
    OutboxPollerService,
  ],
  // Exported so any module (identity today; orders/disputes/admin later) can
  // enqueue a best-effort notification through this service — never by
  // reaching into notifications' domain/infrastructure directly.
  exports: [OutboxService],
})
export class NotificationsModule {}
