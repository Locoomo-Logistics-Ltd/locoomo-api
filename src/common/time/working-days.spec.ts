import { addWorkingDays, isWorkingDay, lagosDate } from './working-days';

describe('working days (Africa/Lagos)', () => {
  it('reads the Lagos calendar day, not UTC', () => {
    // 23:30 UTC on the 13th is already 00:30 on the 14th in Lagos.
    expect(lagosDate(new Date('2026-11-13T23:30:00Z'))).toBe('2026-11-14');
  });

  it('skips weekends and holidays', () => {
    const holidays = new Set(['2026-12-25']);
    expect(isWorkingDay('2026-11-16', holidays)).toBe(true); // Monday
    expect(isWorkingDay('2026-11-14', holidays)).toBe(false); // Saturday
    expect(isWorkingDay('2026-12-25', holidays)).toBe(false); // Christmas
  });

  it('ends the window at 23:59:59 Lagos on the last working day', () => {
    // Friday 13 Nov, 10:00 Lagos + 7 working days → Tuesday 24 Nov.
    expect(
      addWorkingDays(new Date('2026-11-13T09:00:00Z'), 7).toISOString(),
    ).toBe('2026-11-24T22:59:59.000Z');
  });

  it('pushes the deadline past public holidays', () => {
    // Shelved Wed 23 Dec; Christmas (Fri) and Boxing Day (Sat) don't count,
    // Mon 28 Dec is a holiday too: 2 working days → Thu 24, Tue 29.
    const holidays = new Set(['2026-12-25', '2026-12-26', '2026-12-28']);
    expect(
      addWorkingDays(
        new Date('2026-12-23T12:00:00Z'),
        2,
        holidays,
      ).toISOString(),
    ).toBe('2026-12-29T22:59:59.000Z');
  });
});
