// How a merchant quote is presented (MERCHANT_API.md §6): the checkout
// fee calculation mapped onto the merchant breakdown. Prices are
// VAT-inclusive (plan §8.3); `vatKobo` is the VAT *included* in
// `amountKobo`, shown only once VAT is switched on (F3).

export const VAT_RATE = 0.075;

export interface FeeParts {
  baseFeeKobo: number;
  deliveryFeeKobo: number;
  destinationFeeKobo: number;
  totalKobo: number;
}

export interface QuoteBreakdown {
  // Flat part: vehicle base fee + destination Node fee.
  baseKobo: number;
  // Per-km part for this route.
  distanceKobo: number;
  // Negative (or 0): the merchant's volume discount (from M4).
  volumeDiscountKobo: number;
  // VAT included in amountKobo (0 while VAT is off). Not added on top.
  vatKobo: number;
}

export function merchantQuoteAmounts(
  fee: FeeParts,
  options: {
    discountRate: number;
    vatEnabled: boolean;
    // Cap on the discount (the platform share it comes out of, E7).
    maxDiscountKobo?: number;
  },
): { amountKobo: number; breakdown: QuoteBreakdown } {
  const wanted = Math.round(fee.totalKobo * options.discountRate);
  const volumeDiscountKobo =
    0 - Math.min(wanted, options.maxDiscountKobo ?? wanted);
  const amountKobo = fee.totalKobo + volumeDiscountKobo;
  return {
    amountKobo,
    breakdown: {
      baseKobo: fee.baseFeeKobo + fee.destinationFeeKobo,
      distanceKobo: fee.deliveryFeeKobo - fee.baseFeeKobo,
      volumeDiscountKobo,
      vatKobo: options.vatEnabled
        ? Math.round((amountKobo * VAT_RATE) / (1 + VAT_RATE))
        : 0,
    },
  };
}

// Drop-off to on the shelf, in working days: a day to sort and dispatch,
// plus a working day (8 hours of moving) per started block of road time.
export function estimatedReadyInWorkingDays(courierMinutes: number): number {
  return 1 + Math.max(1, Math.ceil(courierMinutes / 480));
}
