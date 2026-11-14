import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { Env } from '../../../config/env.validation';
import { PaystackWalletGateway } from './paystack-wallet.gateway';

function gateway(values: Partial<Record<keyof Env, string>>) {
  const config = {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
  return new PaystackWalletGateway(config);
}

describe('PaystackWalletGateway keys', () => {
  it('live mode always uses the main key', () => {
    expect(
      gateway({ PAYSTACK_SECRET_KEY: 'sk_live_main' }).keyFor('live'),
    ).toBe('sk_live_main');
  });

  it('test mode uses the dedicated test key when set', () => {
    expect(
      gateway({
        PAYSTACK_SECRET_KEY: 'sk_live_main',
        PAYSTACK_TEST_SECRET_KEY: 'sk_test_extra',
      }).keyFor('test'),
    ).toBe('sk_test_extra');
  });

  it('test mode falls back to a main key that is itself a test key (staging)', () => {
    const staging = gateway({ PAYSTACK_SECRET_KEY: 'sk_test_main' });
    expect(staging.keyFor('test')).toBe('sk_test_main');
    expect(staging.isAvailable('test')).toBe(true);
  });

  it('test mode is unavailable in production without a test key', () => {
    const production = gateway({ PAYSTACK_SECRET_KEY: 'sk_live_main' });
    expect(production.keyFor('test')).toBeNull();
    expect(production.isAvailable('test')).toBe(false);
  });

  it('picks the DVA bank from the key unless configured', () => {
    expect(gateway({ PAYSTACK_SECRET_KEY: 'sk_test_x' }).preferredBank()).toBe(
      'test-bank',
    );
    expect(gateway({ PAYSTACK_SECRET_KEY: 'sk_live_x' }).preferredBank()).toBe(
      'wema-bank',
    );
    expect(
      gateway({
        PAYSTACK_SECRET_KEY: 'sk_live_x',
        PAYSTACK_DVA_PREFERRED_BANK: 'titan-paystack',
      }).preferredBank(),
    ).toBe('titan-paystack');
  });

  it('recognises webhooks signed with the test key only', () => {
    const body = Buffer.from('{"event":"charge.success"}');
    const sign = (key: string) =>
      createHmac('sha512', key).update(body).digest('hex');
    const g = gateway({
      PAYSTACK_SECRET_KEY: 'sk_live_main',
      PAYSTACK_TEST_SECRET_KEY: 'sk_test_extra',
    });
    expect(g.isTestKeySignature(body, sign('sk_test_extra'))).toBe(true);
    expect(g.isTestKeySignature(body, sign('sk_live_main'))).toBe(false);
    expect(g.isTestKeySignature(body, undefined)).toBe(false);
    expect(
      gateway({ PAYSTACK_SECRET_KEY: 'sk_test_main' }).isTestKeySignature(
        body,
        sign('sk_test_main'),
      ),
    ).toBe(false);
  });
});
