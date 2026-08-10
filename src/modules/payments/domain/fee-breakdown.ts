// Snapshotted onto a PaymentIntent at creation and never recomputed — see
// PricingService. All amounts are integer kobo (Paystack's minor unit);
// nothing in this codebase stores money as a float.
export interface FeeBreakdown {
  pricingRuleId: string;
  baseFeeKobo: number;
  perKmRateKobo: number;
  distanceKm: number;
  totalKobo: number;
}
