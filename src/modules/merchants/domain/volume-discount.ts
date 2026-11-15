// Volume discounts (plan §8.3, D9, F1): a merchant's tier for the month is
// set by last month's shipments that were collected or came back (returned
// or waiting to be collected as a return). Funded from the platform share
// only and never more than it (E7).

export interface DiscountTier {
  minShipments: number;
  percent: number;
}

// F1 defaults (commercial may change them in the admin app).
export const DEFAULT_TIERS: readonly DiscountTier[] = [
  { minShipments: 0, percent: 0 },
  { minShipments: 500, percent: 5 },
  { minShipments: 5_000, percent: 10 },
  { minShipments: 50_000, percent: 15 },
];

// Statuses that count towards next month's tier.
export const COUNTED_STATUSES = ['collected', 'returned', 'return_ready'];

export const MAX_DISCOUNT_PERCENT = 50;

// Tiers sorted, starting at 0 shipments, percents within bounds; null if
// the set is unusable.
export function normaliseTiers(tiers: DiscountTier[]): DiscountTier[] | null {
  if (tiers.length === 0 || tiers.length > 20) {
    return null;
  }
  const sorted = [...tiers].sort((a, b) => a.minShipments - b.minShipments);
  if (sorted[0].minShipments !== 0) {
    return null;
  }
  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i];
    if (
      !Number.isInteger(tier.minShipments) ||
      tier.minShipments < 0 ||
      !(tier.percent >= 0 && tier.percent <= MAX_DISCOUNT_PERCENT) ||
      (i > 0 && tier.minShipments === sorted[i - 1].minShipments)
    ) {
      return null;
    }
  }
  return sorted;
}

export function tierFor(
  shipments: number,
  tiers: readonly DiscountTier[],
): { current: DiscountTier; next: DiscountTier | null } {
  let current = tiers[0];
  let next: DiscountTier | null = null;
  for (const tier of tiers) {
    if (shipments >= tier.minShipments) {
      current = tier;
    } else {
      next = tier;
      break;
    }
  }
  return { current, next };
}

// The most a discount may be on one shipment: the platform's share of the
// delivery revenue (total less the destination Node's fee). Null rule (no
// revenue split set up yet) → no discount can be funded.
export function maxDiscountKobo(
  totalKobo: number,
  destinationFeeKobo: number,
  platformPercent: number | null,
): number {
  if (platformPercent === null) {
    return 0;
  }
  return Math.max(
    Math.floor(((totalKobo - destinationFeeKobo) * platformPercent) / 100),
    0,
  );
}
