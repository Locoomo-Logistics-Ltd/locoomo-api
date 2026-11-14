// Working days for Nigerian operations (plan §5.5): Monday–Friday in
// Africa/Lagos (UTC+1 all year, no DST), minus public holidays. Pure:
// callers pass the holidays (orders' PublicHolidayService keeps the list).

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

// "YYYY-MM-DD" of the Lagos calendar day containing `instant`.
export function lagosDate(instant: Date): string {
  return new Date(instant.getTime() + LAGOS_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

export function isWorkingDay(
  lagosDay: string,
  holidays: ReadonlySet<string>,
): boolean {
  const weekday = new Date(`${lagosDay}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(lagosDay);
}

// The end (23:59:59 Lagos) of the `days`-th working day after the day of
// `from`. The starting day itself never counts, so a parcel shelved at
// 8pm still gets `days` full working days.
export function addWorkingDays(
  from: Date,
  days: number,
  holidays: ReadonlySet<string> = new Set(),
): Date {
  let day = lagosDate(from);
  let added = 0;
  while (added < days) {
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
    if (isWorkingDay(day, holidays)) {
      added++;
    }
  }
  return new Date(new Date(`${day}T23:59:59Z`).getTime() - LAGOS_OFFSET_MS);
}

// "Tuesday 24 November" in Lagos time, for "collect by …" copy.
export function formatLagosDay(instant: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(instant);
}
