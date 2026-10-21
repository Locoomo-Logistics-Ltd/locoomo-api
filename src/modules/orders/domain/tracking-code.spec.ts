import { generateTrackingCode, normalizeTrackingCode } from './tracking-code';

describe('normalizeTrackingCode', () => {
  it.each([
    ['LCM-4F2K-9XPT', 'LCM-4F2K-9XPT'],
    ['lcm-4f2k-9xpt', 'LCM-4F2K-9XPT'],
    ['LCM 4F2K 9XPT', 'LCM-4F2K-9XPT'],
    ['lcm4f2k9xpt', 'LCM-4F2K-9XPT'],
    ['4F2K-9XPT', 'LCM-4F2K-9XPT'],
    ['4f2k9xpt', 'LCM-4F2K-9XPT'],
    ['  4F2K 9XPT  ', 'LCM-4F2K-9XPT'],
  ])('accepts %p', (input, expected) => {
    expect(normalizeTrackingCode(input)).toBe(expected);
  });

  it('reads the look-alike letters as the digits they are mistaken for', () => {
    expect(normalizeTrackingCode('LCM-OOIL-7KMN')).toBe('LCM-0011-7KMN');
  });

  it('extracts the code from a pasted tracking URL', () => {
    expect(
      normalizeTrackingCode(
        'https://app.locoomo.com/track/LCM-4F2K-9XPT?t=abc123',
      ),
    ).toBe('LCM-4F2K-9XPT');
  });

  it.each(['', 'LCM-4F2K', 'LCM-4F2K-9XPT-1', 'LCM-4F2K-9XP!', 'hello world'])(
    'rejects %p',
    (input) => {
      expect(normalizeTrackingCode(input)).toBeNull();
    },
  );

  it('round-trips every generated code', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateTrackingCode();
      expect(normalizeTrackingCode(code)).toBe(code);
      expect(normalizeTrackingCode(code.toLowerCase().replace(/-/g, ' '))).toBe(
        code,
      );
    }
  });
});
