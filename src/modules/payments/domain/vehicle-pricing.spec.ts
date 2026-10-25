import {
  deliveryFeeKobo,
  estimateDeliveryMinutes,
  rateFor,
} from './vehicle-pricing';

describe('vehicle pricing', () => {
  // The recommended motorbike rate: ₦1,100 + ₦320 per road-km.
  const rule = {
    baseFeeKobo: 110_000,
    perKmRateKobo: 32_000,
    vehicleRates: {},
  };

  it("uses the rule's own rate for a motorbike", () => {
    expect(rateFor(rule, 'motorbike')).toEqual({
      baseFeeKobo: 110_000,
      perKmRateKobo: 32_000,
    });
  });

  it('scales other vehicles by their multiplier', () => {
    expect(rateFor(rule, 'car')).toEqual({
      baseFeeKobo: 264_000,
      perKmRateKobo: 76_800,
    });
  });

  it('prefers an explicit per-vehicle rate on the rule', () => {
    const withCar = {
      ...rule,
      vehicleRates: { car: { baseFeeKobo: 250_000, perKmRateKobo: 78_000 } },
    };
    expect(rateFor(withCar, 'car').baseFeeKobo).toBe(250_000);
  });

  it('keeps the 60% rider allocation above the sampled Sendii motorbike cost', () => {
    // Onipanu → Ejigbo: 9.2 road-km, Sendii quoted ₦2,400.
    const fee = deliveryFeeKobo(rateFor(rule, 'motorbike'), 9.2);
    expect(fee).toBe(404_400);
    expect(fee * 0.6).toBeGreaterThanOrEqual(240_000);
  });

  it('estimates the courier leg in 5-minute steps', () => {
    expect(estimateDeliveryMinutes(0)).toBe(15);
    expect(estimateDeliveryMinutes(9.2)).toBe(50);
  });
});
