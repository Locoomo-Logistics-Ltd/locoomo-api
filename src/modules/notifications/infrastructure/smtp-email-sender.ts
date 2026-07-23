import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { Env } from '../../../config/env.validation';
import { EmailMessage } from '../domain/email-message';
import { NotificationSender } from '../domain/notification-sender.port';
import { MAIL_TRANSPORTER } from './mail-transporter.provider';

@Injectable()
export class SmtpEmailSender implements NotificationSender {
  constructor(
    @Inject(MAIL_TRANSPORTER) private readonly transporter: Transporter,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async sendEmail(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.configService.get('SMTP_FROM', { infer: true }),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
