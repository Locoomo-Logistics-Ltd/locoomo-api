import { redact, REDACTED } from './redact';

describe('redact', () => {
  it('redacts credentials, secrets and personal data at any depth', () => {
    expect(
      redact({
        name: 'Ada Stores',
        passwordHash: 'x',
        apiKey: 'sk_live_abc',
        webhookSecret: 'whsec_x',
        bank: { accountNumber: '0123456789', bankCode: '058' },
        owner: { email: 'a@b.c', phone: '+2348000000000', bvn: '222' },
        directors: [{ idNumber: 'A123', nin: '111' }],
      }),
    ).toEqual({
      name: 'Ada Stores',
      passwordHash: REDACTED,
      apiKey: REDACTED,
      webhookSecret: REDACTED,
      bank: { accountNumber: REDACTED, bankCode: '058' },
      owner: { email: REDACTED, phone: REDACTED, bvn: REDACTED },
      directors: [{ idNumber: REDACTED, nin: REDACTED }],
    });
  });

  it('keeps identifiers and labels that merely contain a sensitive word', () => {
    expect(
      redact({
        keyId: 'k1',
        trackingCode: 'LCM-1234-5678',
        errorCode: 'X',
        merchantId: 'm1',
        status: 'active',
      }),
    ).toEqual({
      keyId: 'k1',
      trackingCode: 'LCM-1234-5678',
      errorCode: 'X',
      merchantId: 'm1',
      status: 'active',
    });
  });

  it('passes through primitives, null and dates', () => {
    const date = new Date();
    expect(redact(null)).toBeNull();
    expect(redact(5)).toBe(5);
    expect(redact({ at: date })).toEqual({ at: date });
  });
});
