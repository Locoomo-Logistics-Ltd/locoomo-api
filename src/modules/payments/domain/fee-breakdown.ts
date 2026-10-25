// Snapshot of how an order's price was worked out, stored on the payment
// intent at checkout. baseFeeKobo/perKmRateKobo are the rates actually
// applied for vehicleClass (not necessarily the rule's motorbike rate).
export interface FeeBreakdown {
  pricingRuleId: string;
  vehicleClass: string;
  baseFeeKobo: number;
  perKmRateKobo: number;
  // Road distance used for pricing: measured by a courier for this Node
  // pair ('route'), or straight line × the rule's factor ('estimate').
  distanceKm: number;
  distanceSource: 'route' | 'estimate';
  straightLineKm: number;
  deliveryFeeKobo: number;
  destinationFeeKobo: number;
  totalKobo: number;
}
