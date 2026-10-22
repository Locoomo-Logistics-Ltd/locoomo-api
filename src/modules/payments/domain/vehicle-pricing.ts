// How a delivery fee depends on the vehicle and the road distance.
//
// Placeholder economics until the Locoomo–Sendii pricing formula is agreed
// (decision 2). Derived from Sendii sandbox quotes between Lagos Nodes
// (Oct 2026): motorbike ≈ ₦659 + ₦187 per road-km, car ≈ ₦1,506 + ₦462 per
// road-km — consistently ~2.4× a motorbike; road distance 1.16–1.90× the
// straight line (median ≈ 1.4). A pricing rule's own base/per-km fields are
// the motorbike rate; the recommended motorbike rate is ₦1,100 + ₦320 per
// road-km (Sendii's cost ÷ 0.6, so the 60% rider allocation covers it).

export const VEHICLE_RATE_MULTIPLIERS: Record<string, number> = {
  bicycle: 0.7,
  motorbike: 1,
  car: 2.4,
  van: 5,
  truck: 8,
};

export interface VehicleRate {
  baseFeeKobo: number;
  perKmRateKobo: number;
}

export interface PricingRuleRates {
  baseFeeKobo: number;
  perKmRateKobo: number;
  vehicleRates: Partial<Record<string, VehicleRate>>;
}

// An explicit per-vehicle rate on the rule wins; otherwise the motorbike
// rate scaled by the class's multiplier.
export function rateFor(
  rule: PricingRuleRates,
  vehicleClass: string,
): VehicleRate {
  const explicit = rule.vehicleRates[vehicleClass];
  if (explicit) {
    return explicit;
  }
  const multiplier = VEHICLE_RATE_MULTIPLIERS[vehicleClass] ?? 1;
  return {
    baseFeeKobo: Math.round(rule.baseFeeKobo * multiplier),
    perKmRateKobo: Math.round(rule.perKmRateKobo * multiplier),
  };
}

export function deliveryFeeKobo(rate: VehicleRate, distanceKm: number): number {
  return rate.baseFeeKobo + Math.round(rate.perKmRateKobo * distanceKm);
}

// Rough courier-leg duration for showing at checkout: 15 minutes to get a
// rider to the counter, then Lagos traffic at ~18 km/h, rounded up to the
// next 5 minutes. Not a promise.
export function estimateDeliveryMinutes(roadKm: number): number {
  const minutes = 15 + (roadKm / 18) * 60;
  return Math.ceil(minutes / 5) * 5;
}
