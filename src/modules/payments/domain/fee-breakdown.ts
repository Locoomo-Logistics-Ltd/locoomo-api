// Snapshotted onto a PaymentIntent at creation and never recomputed — see
// PricingService. All amounts are integer kobo (Paystack's minor unit);
// nothing in this codebase stores money as a float.
export interface FeeBreakdown {
  pricingRuleId: string;
  baseFeeKobo: number;
  perKmRateKobo: number;
  // Flat, paid entirely to the destination Node on order completion — not
  // part of the rider/origin-Node/platform split. See RevenueSplitPartyType.
  destinationFeeKobo: number;
  distanceKm: number;
  totalKobo: number;
}
