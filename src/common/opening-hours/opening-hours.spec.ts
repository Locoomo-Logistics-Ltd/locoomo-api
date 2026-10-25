import { isOpenAt, OpeningHours, validateOpeningHours } from './opening-hours';

describe('validateOpeningHours', () => {
  it('accepts a normal week with a split day and closed days', () => {
    expect(
      validateOpeningHours({
        mon: [{ open: '08:00', close: '18:00' }],
        sat: [
          { open: '09:00', close: '12:00' },
          { open: '13:00', close: '16:00' },
        ],
        sun: [],
      }),
    ).toBeNull();
  });

  it.each([
    ['a non-object', 'Mon-Fri 8-6', /object keyed by day/],
    ['an array', [], /object keyed by day/],
    ['an unknown day', { monday: [] }, /unknown day "monday"/],
    ['a non-array day', { mon: { open: '08:00', close: '18:00' } }, /array/],
    ['a bad time', { mon: [{ open: '8am', close: '18:00' }] }, /HH:mm/],
    ['24:00', { mon: [{ open: '08:00', close: '24:00' }] }, /HH:mm/],
    [
      'close before open',
      { mon: [{ open: '18:00', close: '08:00' }] },
      /closes before it opens/,
    ],
    [
      'overlapping intervals',
      {
        mon: [
          { open: '08:00', close: '13:00' },
          { open: '12:00', close: '18:00' },
        ],
      },
      /not overlap/,
    ],
    [
      'extra keys',
      { mon: [{ open: '08:00', close: '18:00', note: 'x' }] },
      /only allow open and close/,
    ],
  ])('rejects %s', (_label, value, reason) => {
    expect(validateOpeningHours(value)).toMatch(reason);
  });
});

describe('isOpenAt', () => {
  const hours: OpeningHours = {
    mon: [{ open: '08:00', close: '18:00' }],
    sat: [{ open: '09:00', close: '14:00' }],
  };

  // 2026-10-19 is a Monday. Lagos is UTC+1, so 08:00 Lagos = 07:00Z.
  it('is open inside an interval, in Lagos time', () => {
    expect(isOpenAt(hours, new Date('2026-10-19T07:00:00Z'))).toBe(true);
    expect(isOpenAt(hours, new Date('2026-10-19T16:59:00Z'))).toBe(true);
  });

  it('is closed at and after closing time', () => {
    expect(isOpenAt(hours, new Date('2026-10-19T17:00:00Z'))).toBe(false);
  });

  it('is closed before opening (06:59Z is 07:59 Lagos)', () => {
    expect(isOpenAt(hours, new Date('2026-10-19T06:59:00Z'))).toBe(false);
  });

  it('uses the Lagos day across the UTC midnight boundary', () => {
    // Sunday 23:30Z is already Monday 00:30 in Lagos — closed (Monday opens at 08:00),
    // and Sunday has no hours either way.
    expect(isOpenAt(hours, new Date('2026-10-18T23:30:00Z'))).toBe(false);
    // Saturday 08:30Z = Saturday 09:30 Lagos.
    expect(isOpenAt(hours, new Date('2026-10-24T08:30:00Z'))).toBe(true);
  });

  it('treats a missing day as closed', () => {
    expect(isOpenAt(hours, new Date('2026-10-20T10:00:00Z'))).toBe(false);
  });
});
