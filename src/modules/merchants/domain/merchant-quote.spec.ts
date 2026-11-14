import {
  estimatedReadyInWorkingDays,
  merchantQuoteAmounts,
} from './merchant-quote';

const fee = {
  baseFeeKobo: 100_000,
  deliveryFeeKobo: 160_000,
  destinationFeeKobo: 20_000,
  totalKobo: 180_000,
};

describe('merchant quote amounts', () => {
  it('splits the fee into base and distance parts that add up to the amount', () => {
    const { amountKobo, breakdown } = merchantQuoteAmounts(fee, {
      discountRate: 0,
      vatEnabled: false,
    });
    expect(amountKobo).toBe(180_000);
    expect(breakdown).toEqual({
      baseKobo: 120_000,
      distanceKobo: 60_000,
      volumeDiscountKobo: 0,
      vatKobo: 0,
    });
    expect(
      breakdown.baseKobo +
        breakdown.distanceKobo +
        breakdown.volumeDiscountKobo,
    ).toBe(amountKobo);
  });

  it('applies the discount and shows the VAT already included', () => {
    const { amountKobo, breakdown } = merchantQuoteAmounts(fee, {
      discountRate: 0.05,
      vatEnabled: true,
    });
    expect(breakdown.volumeDiscountKobo).toBe(-9_000);
    expect(amountKobo).toBe(171_000);
    // 171,000 × 7.5 / 107.5
    expect(breakdown.vatKobo).toBe(11_930);
  });

  it('estimates working days from drop-off to ready for collection', () => {
    expect(estimatedReadyInWorkingDays(30)).toBe(2);
    expect(estimatedReadyInWorkingDays(480)).toBe(2);
    expect(estimatedReadyInWorkingDays(900)).toBe(3);
  });
});
