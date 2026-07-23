import { ConfigService } from '@nestjs/config';
import { Provider } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { Env } from '../../../config/env.validation';

export const MAIL_TRANSPORTER = Symbol('MAIL_TRANSPORTER');

// Builds the actual SMTP client from config — kept separate from
// SmtpEmailSender so that class only has to know how to map an EmailMessage
// onto a transporter, not how to construct one. Makes SmtpEmailSender
// trivially testable with a fake transporter, no real SMTP involved.
export const mailTransporterProvider: Provider = {
  provide: MAIL_TRANSPORTER,
  useFactory: (configService: ConfigService<Env, true>): Transporter =>
    nodemailer.createTransport({
      host: configService.get('SMTP_HOST', { infer: true }),
      port: configService.get('SMTP_PORT', { infer: true }),
      secure: configService.get('SMTP_SECURE', { infer: true }),
      auth: {
        user: configService.get('SMTP_USER', { infer: true }),
        pass: configService.get('SMTP_PASSWORD', { infer: true }),
      },
    }),
  inject: [ConfigService],
};
