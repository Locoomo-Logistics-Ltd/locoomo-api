import {
  availableKobo,
  creditedAmount,
  exceedsWalletCeiling,
  formatNaira,
  MAX_ADJUSTMENT_KOBO,
  parseAdjustmentPayload,
} from './wallet';

describe('top-ups', () => {
  it('passes card fees on and absorbs transfer fees', () => {
    expect(creditedAmount('card', 500_000, 7_500)).toBe(492_500);
    expect(creditedAmount('bank_transfer', 500_000, 5_000)).toBe(500_000);
    expect(creditedAmount('card', 100, 500)).toBe(0);
  });

  it('enforces the wallet ceiling only when there is one', () => {
    expect(exceedsWalletCeiling(900, 100, 1_000)).toBe(false);
    expect(exceedsWalletCeiling(901, 100, 1_000)).toBe(true);
    expect(exceedsWalletCeiling(10 ** 12, 1, null)).toBe(false);
    expect(exceedsWalletCeiling(10 ** 12, 1, undefined)).toBe(false);
  });
});

describe('wallet domain', () => {
  it('available is balance minus held, and can go negative', () => {
    expect(availableKobo({ balanceKobo: 500_000, heldKobo: 180_000 })).toBe(
      320_000,
    );
    expect(availableKobo({ balanceKobo: -5_000, heldKobo: 0 })).toBe(-5_000);
  });

  it('formats kobo as naira', () => {
    expect(formatNaira(2_500_000)).toBe('₦25,000.00');
    expect(formatNaira(-125_050)).toBe('−₦1,250.50');
    expect(formatNaira(0)).toBe('₦0.00');
  });

  describe('parseAdjustmentPayload', () => {
    const valid = { merchantId: 'm1', mode: 'live', amountKobo: 2_500_000 };

    it('accepts credits and debits', () => {
      expect(parseAdjustmentPayload(valid)).toEqual(valid);
      expect(
        parseAdjustmentPayload({ ...valid, amountKobo: -100 }),
      ).toMatchObject({ amountKobo: -100 });
    });

    it.each([
      ['zero', { amountKobo: 0 }],
      ['fractional kobo', { amountKobo: 10.5 }],
      ['a string amount', { amountKobo: '100' }],
      ['over the ceiling', { amountKobo: MAX_ADJUSTMENT_KOBO + 1 }],
      ['an unknown mode', { mode: 'staging' }],
      ['no merchant', { merchantId: undefined }],
    ])('rejects %s', (_label, change) => {
      expect(parseAdjustmentPayload({ ...valid, ...change })).toBeNull();
    });
  });
});
