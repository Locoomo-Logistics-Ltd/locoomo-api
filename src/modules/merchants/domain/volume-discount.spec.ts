import { merchantQuoteAmounts } from './merchant-quote';
import {
  DEFAULT_TIERS,
  maxDiscountKobo,
  normaliseTiers,
  tierFor,
} from './volume-discount';

describe('volume discounts', () => {
  it('picks the tier for last month’s count, and the next one up', () => {
    expect(tierFor(0, DEFAULT_TIERS)).toEqual({
      current: { minShipments: 0, percent: 0 },
      next: { minShipments: 500, percent: 5 },
    });
    expect(tierFor(4_999, DEFAULT_TIERS).current.percent).toBe(5);
    expect(tierFor(5_000, DEFAULT_TIERS).current.percent).toBe(10);
    expect(tierFor(60_000, DEFAULT_TIERS)).toEqual({
      current: { minShipments: 50_000, percent: 15 },
      next: null,
    });
  });

  it('accepts only a usable tier set', () => {
    expect(
      normaliseTiers([
        { minShipments: 100, percent: 3 },
        { minShipments: 0, percent: 0 },
      ]),
    ).toEqual([
      { minShipments: 0, percent: 0 },
      { minShipments: 100, percent: 3 },
    ]);
    expect(normaliseTiers([{ minShipments: 10, percent: 1 }])).toBeNull();
    expect(
      normaliseTiers([
        { minShipments: 0, percent: 0 },
        { minShipments: 0, percent: 5 },
      ]),
    ).toBeNull();
    expect(normaliseTiers([{ minShipments: 0, percent: 60 }])).toBeNull();
    expect(normaliseTiers([])).toBeNull();
  });

  it('caps the discount at the platform share of delivery revenue (E7)', () => {
    // ₦2,000 total, ₦200 destination fee, platform 20% → ₦360 at most.
    expect(maxDiscountKobo(200_000, 20_000, 20)).toBe(36_000);
    expect(maxDiscountKobo(200_000, 20_000, null)).toBe(0);
    const capped = merchantQuoteAmounts(
      {
        baseFeeKobo: 100_000,
        deliveryFeeKobo: 180_000,
        destinationFeeKobo: 20_000,
        totalKobo: 200_000,
      },
      { discountRate: 0.5, vatEnabled: false, maxDiscountKobo: 36_000 },
    );
    expect(capped.breakdown.volumeDiscountKobo).toBe(-36_000);
    expect(capped.amountKobo).toBe(164_000);
    const within = merchantQuoteAmounts(
      {
        baseFeeKobo: 100_000,
        deliveryFeeKobo: 180_000,
        destinationFeeKobo: 20_000,
        totalKobo: 200_000,
      },
      { discountRate: 0.1, vatEnabled: false, maxDiscountKobo: 36_000 },
    );
    expect(within.breakdown.volumeDiscountKobo).toBe(-20_000);
  });
});
