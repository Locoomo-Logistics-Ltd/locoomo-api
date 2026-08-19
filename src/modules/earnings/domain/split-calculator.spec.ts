import { calculateSplit } from './split-calculator';

describe('calculateSplit', () => {
  it('splits an evenly-divisible amount exactly per the 60/20/20 ratio', () => {
    const shares = calculateSplit(100_000, 60, 20);
    expect(shares).toEqual({
      riderShareKobo: 60_000,
      nodeShareKobo: 20_000,
      platformShareKobo: 20_000,
    });
  });

  it('always sums exactly to amountKobo, even when percentages divide unevenly', () => {
    // 100333 * 0.6 = 60199.8, * 0.2 = 20066.6 — neither divides evenly.
    const amountKobo = 100_333;
    const shares = calculateSplit(amountKobo, 60, 20);
    expect(
      shares.riderShareKobo + shares.nodeShareKobo + shares.platformShareKobo,
    ).toBe(amountKobo);
  });

  it('absorbs the rounding remainder into the platform share, not rider or node', () => {
    const shares = calculateSplit(101, 60, 20);
    // floor(101*0.6)=60, floor(101*0.2)=20, remainder (101-60-20=21) all to platform.
    expect(shares.riderShareKobo).toBe(60);
    expect(shares.nodeShareKobo).toBe(20);
    expect(shares.platformShareKobo).toBe(21);
  });

  it('handles a zero amount without producing negative shares', () => {
    const shares = calculateSplit(0, 60, 20);
    expect(shares).toEqual({
      riderShareKobo: 0,
      nodeShareKobo: 0,
      platformShareKobo: 0,
    });
  });

  it('sums exactly across a range of odd amounts (property check)', () => {
    for (let amountKobo = 1; amountKobo <= 500; amountKobo++) {
      const shares = calculateSplit(amountKobo, 60, 20);
      expect(
        shares.riderShareKobo + shares.nodeShareKobo + shares.platformShareKobo,
      ).toBe(amountKobo);
      expect(shares.riderShareKobo).toBeGreaterThanOrEqual(0);
      expect(shares.nodeShareKobo).toBeGreaterThanOrEqual(0);
      expect(shares.platformShareKobo).toBeGreaterThanOrEqual(0);
    }
  });
});
