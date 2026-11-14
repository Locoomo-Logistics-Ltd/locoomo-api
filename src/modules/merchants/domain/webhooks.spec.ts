import { createHmac } from 'crypto';
import {
  generateWebhookSecret,
  isPublicAddress,
  newWebhookMessageId,
  nextRetryDelaySeconds,
  RETRY_DELAYS_SECONDS,
  signWebhook,
  webhookUrlProblem,
} from './webhooks';

describe('webhooks', () => {
  it('signs exactly like the verification snippet in MERCHANT_API.md §12.3', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const body = '{"id":"msg_1","type":"shipment.created"}';
    const signature = signWebhook(secret, 'msg_1', 1763039100, body);
    const expected = createHmac(
      'sha256',
      Buffer.from(secret.replace(/^whsec_/, ''), 'base64'),
    )
      .update(`msg_1.1763039100.${body}`)
      .digest('base64');
    expect(signature).toBe(`v1,${expected}`);
  });

  it('matches the Standard Webhooks reference vector', () => {
    // From the Standard Webhooks spec test suite.
    expect(
      signWebhook(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('retries on the documented schedule, about a day and a half in total', () => {
    expect(nextRetryDelaySeconds(1)).toBe(5);
    expect(nextRetryDelaySeconds(9)).toBe(36_000);
    expect(nextRetryDelaySeconds(10)).toBeNull();
    const totalHours =
      RETRY_DELAYS_SECONDS.reduce((sum, s) => sum + s, 0) / 3600;
    expect(totalHours).toBeGreaterThan(36);
    expect(totalHours).toBeLessThan(48);
  });

  it.each([
    ['8.8.8.8', true],
    ['102.89.1.1', true],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:10.0.0.1', false],
    ['2a00:1450:4001::200e', true],
    ['not-an-ip', false],
  ])('treats %s as public: %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it.each([
    ['https://hooks.example.com/locoomo', null],
    ['http://hooks.example.com/locoomo', 'url must use https'],
    ['https://localhost/x', 'url must be a public address'],
    ['https://10.0.0.5/x', 'url must be a public address'],
    ['https://[::1]/x', 'url must be a public address'],
    ['https://user:pw@example.com/x', 'url must not contain credentials'],
    ['nope', 'url must be a valid URL'],
  ])('validates %s', (url, problem) => {
    expect(webhookUrlProblem(url)).toBe(problem);
  });

  it('makes message ids in the documented shape', () => {
    expect(newWebhookMessageId()).toMatch(/^msg_[A-Za-z0-9]{24}$/);
  });
});
