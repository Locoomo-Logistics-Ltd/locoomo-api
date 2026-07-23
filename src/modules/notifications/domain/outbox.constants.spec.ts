import { computeBackoffMs } from './outbox.constants';

describe('computeBackoffMs', () => {
  it('doubles with each attempt', () => {
    expect(computeBackoffMs(1)).toBe(30_000);
    expect(computeBackoffMs(2)).toBe(60_000);
    expect(computeBackoffMs(3)).toBe(120_000);
    expect(computeBackoffMs(4)).toBe(240_000);
  });

  it('caps at the max backoff instead of growing unbounded', () => {
    expect(computeBackoffMs(10)).toBe(15 * 60_000);
    expect(computeBackoffMs(20)).toBe(15 * 60_000);
  });
});
