import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../../config/env.validation';
import { EmailMessage } from '../domain/email-message';
import { NotificationSender } from '../domain/notification-sender.port';

const RESEND_API_URL = 'https://api.resend.com/emails';

// Plain REST call to Resend's HTTPS API (fetch is built into Node 22, no
// SDK) — the fallback for hosts that block outbound SMTP entirely (Railway
// free/hobby tier; see EMAIL_TRANSPORT in env.validation.ts). Mail goes out
// over 443 instead of 465/587, which those hosts don't block.
@Injectable()
export class ResendApiEmailSender implements NotificationSender {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  async sendEmail(message: EmailMessage): Promise<void> {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configService.get('RESEND_API_KEY', { infer: true })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.configService.get('SMTP_FROM', { infer: true }),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Resend API request failed (${response.status}): ${body}`,
      );
    }
  }
}
