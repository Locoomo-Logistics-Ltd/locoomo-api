import { ConfigService } from '@nestjs/config';
import { Transporter } from 'nodemailer';
import { Env } from '../../../config/env.validation';
import { SmtpEmailSender } from './smtp-email-sender';

describe('SmtpEmailSender', () => {
  it('maps an EmailMessage onto the transporter with the configured From address', async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const transporter = { sendMail } as unknown as Transporter;
    const configService = {
      get: jest.fn().mockReturnValue('Locoomo <no-reply@locoomo.dev>'),
    } as unknown as ConfigService<Env, true>;

    const sender = new SmtpEmailSender(transporter, configService);

    await sender.sendEmail({
      to: 'ada@example.com',
      subject: 'Reset your password',
      text: 'Click the link',
      html: '<p>Click the link</p>',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'Locoomo <no-reply@locoomo.dev>',
      to: 'ada@example.com',
      subject: 'Reset your password',
      text: 'Click the link',
      html: '<p>Click the link</p>',
    });
  });

  it('passes inline attachments through as nodemailer cid attachments', async () => {
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const transporter = { sendMail } as unknown as Transporter;
    const configService = {
      get: jest.fn().mockReturnValue('Locoomo <no-reply@locoomo.dev>'),
    } as unknown as ConfigService<Env, true>;

    await new SmtpEmailSender(transporter, configService).sendEmail({
      to: 'ada@example.com',
      subject: 'Your parcel',
      html: '<img src="cid:qr">',
      attachments: [
        {
          filename: 'qr.png',
          contentBase64: Buffer.from('png-bytes').toString('base64'),
          contentType: 'image/png',
          contentId: 'qr',
        },
      ],
    });

    const [mail] = sendMail.mock.calls[0] as [
      { attachments: { content: Buffer; cid: string; contentType: string }[] },
    ];
    expect(mail.attachments[0].cid).toBe('qr');
    expect(mail.attachments[0].contentType).toBe('image/png');
    expect(mail.attachments[0].content.toString()).toBe('png-bytes');
  });

  it('propagates a transporter failure instead of swallowing it', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValue(new Error('SMTP connection refused'));
    const transporter = { sendMail } as unknown as Transporter;
    const configService = {
      get: jest.fn().mockReturnValue('Locoomo <no-reply@locoomo.dev>'),
    } as unknown as ConfigService<Env, true>;

    const sender = new SmtpEmailSender(transporter, configService);

    await expect(
      sender.sendEmail({ to: 'ada@example.com', subject: 'Hi' }),
    ).rejects.toThrow('SMTP connection refused');
  });
});
