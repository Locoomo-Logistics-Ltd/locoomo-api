import {
  addDays,
  disposeAtFor,
  lagosDay,
  storageDaysDue,
} from './return-storage';

describe('return storage', () => {
  it('reads Lagos days', () => {
    expect(lagosDay(new Date('2026-11-15T23:30:00Z'))).toBe('2026-11-16');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('charges each day from the start through today, once', () => {
    const from = new Date('2026-11-10T09:00:00+01:00');
    const now = new Date('2026-11-12T08:00:00+01:00');
    expect(storageDaysDue(from, null, now)).toEqual([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
    ]);
    expect(storageDaysDue(from, '2026-11-11', now)).toEqual(['2026-11-12']);
    expect(storageDaysDue(from, '2026-11-12', now)).toEqual([]);
    expect(
      storageDaysDue(from, null, new Date('2026-11-09T12:00:00Z')),
    ).toEqual([]);
  });

  it('disposes 30 days after fees start', () => {
    expect(disposeAtFor(new Date('2026-11-10T00:00:00Z')).toISOString()).toBe(
      '2026-12-10T00:00:00.000Z',
    );
  });
});
