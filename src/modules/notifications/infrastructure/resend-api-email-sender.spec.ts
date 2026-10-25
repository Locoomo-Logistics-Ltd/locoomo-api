import { ConfigService } from '@nestjs/config';
import { Env } from '../../../config/env.validation';
import { ResendApiEmailSender } from './resend-api-email-sender';

describe('ResendApiEmailSender', () => {
  const configService = {
    get: jest.fn((key: string) =>
      key === 'RESEND_API_KEY'
        ? 're_test_key'
        : 'Locoomo <no-reply@locoomo.dev>',
    ),
  } as unknown as ConfigService<Env, true>;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs an EmailMessage to Resend with the configured From address and API key', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const sender = new ResendApiEmailSender(configService);

    await sender.sendEmail({
      to: 'ada@example.com',
      subject: 'Reset your password',
      text: 'Click the link',
      html: '<p>Click the link</p>',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer re_test_key',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      from: 'Locoomo <no-reply@locoomo.dev>',
      to: 'ada@example.com',
      subject: 'Reset your password',
      text: 'Click the link',
      html: '<p>Click the link</p>',
    });
  });

  it("sends inline attachments with Resend's snake_case fields", async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await new ResendApiEmailSender(configService).sendEmail({
      to: 'ada@example.com',
      subject: 'Your parcel',
      html: '<img src="cid:qr">',
      attachments: [
        {
          filename: 'qr.png',
          contentBase64: 'cG5n',
          contentType: 'image/png',
          contentId: 'qr',
        },
      ],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      attachments: unknown[];
    };
    expect(body.attachments).toEqual([
      {
        filename: 'qr.png',
        content: 'cG5n',
        content_type: 'image/png',
        content_id: 'qr',
      },
    ]);
  });

  it('throws when Resend responds with a non-2xx status instead of swallowing it', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"message":"invalid API key"}', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    const sender = new ResendApiEmailSender(configService);

    await expect(
      sender.sendEmail({ to: 'ada@example.com', subject: 'Hi' }),
    ).rejects.toThrow('Resend API request failed (401)');
  });
});
