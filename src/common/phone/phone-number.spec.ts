import { toE164 } from './phone-number';

describe('toE164', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['0803 123 4567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['+2348031234567', '+2348031234567'],
  ])('normalises Nigerian number %s', (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it('keeps a foreign number written with its country code', () => {
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
  });

  it.each(['', '12345', 'not a phone', '+234123'])('rejects %p', (input) => {
    expect(toE164(input)).toBeNull();
  });
});
