import {
  newReturnBatchCode,
  newReturnBatchReference,
  normaliseReturnBatchReference,
} from './return-batch';

describe('return batches', () => {
  it('makes readable references and 6-digit codes', () => {
    expect(newReturnBatchReference()).toMatch(
      /^RB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(newReturnBatchCode()).toMatch(/^\d{6}$/);
  });

  it('normalises what Node staff type', () => {
    expect(normaliseReturnBatchReference('rb-7kq2-m9xd')).toBe('RB-7KQ2-M9XD');
    expect(normaliseReturnBatchReference('RB 7KQ2 M9XD')).toBe('RB-7KQ2-M9XD');
    expect(normaliseReturnBatchReference('RB7KQ2M9XD')).toBe('RB-7KQ2-M9XD');
    expect(normaliseReturnBatchReference('LCM-2611-7KQ2')).toBeNull();
  });
});
