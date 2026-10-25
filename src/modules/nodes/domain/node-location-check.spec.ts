import { distanceMeters, pinMatchesAddress } from './node-location-check';

describe('distanceMeters', () => {
  it('measures roughly 111 km per degree of latitude', () => {
    const d = distanceMeters(
      { latitude: 6, longitude: 3 },
      { latitude: 7, longitude: 3 },
    );
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('is zero for the same point', () => {
    expect(
      distanceMeters(
        { latitude: 6.45, longitude: 3.47 },
        { latitude: 6.45, longitude: 3.47 },
      ),
    ).toBe(0);
  });
});

describe('pinMatchesAddress', () => {
  const lekki = { latitude: 6.4474, longitude: 3.4723 };

  it('accepts a pin within the 2 km tolerance of a precise match', () => {
    const result = pinMatchesAddress(
      { latitude: 6.455, longitude: 3.4723 }, // ~850 m north
      { ...lekki, uncertaintyMeters: 50 },
    );
    expect(result.matches).toBe(true);
    expect(result.allowedMeters).toBe(2_000);
  });

  it('rejects a pin in the wrong place for a precise match', () => {
    const result = pinMatchesAddress(
      { latitude: 4.7781, longitude: 6.9847 }, // Port Harcourt
      { ...lekki, uncertaintyMeters: 50 },
    );
    expect(result.matches).toBe(false);
    expect(result.distanceMeters).toBeGreaterThan(400_000);
  });

  it("widens the tolerance to the geocoded area's own uncertainty", () => {
    const fiveKmAway = { latitude: 6.4924, longitude: 3.4723 };
    expect(
      pinMatchesAddress(fiveKmAway, { ...lekki, uncertaintyMeters: 50 })
        .matches,
    ).toBe(false);
    expect(
      pinMatchesAddress(fiveKmAway, { ...lekki, uncertaintyMeters: 8_000 })
        .matches,
    ).toBe(true);
  });
});
