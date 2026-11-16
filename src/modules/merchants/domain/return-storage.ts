// Abandoned returns (plan D20, F4): a merchant return waiting at its Node
// is stored free for 10 working days, then charged a daily storage fee;
// 30 days after fees start (with notices), it may be disposed of.

export const RETURN_FREE_WORKING_DAYS = 10;
export const DISPOSAL_AFTER_DAYS = 30;
// The last notice before disposal, this many days ahead.
export const DISPOSAL_NOTICE_DAYS = 7;
// F4 default: ₦100 per parcel per day. RETURN_STORAGE_FEE_KOBO overrides.
export const DEFAULT_STORAGE_FEE_KOBO = 10_000;

const DAY_MS = 86_400_000;

// The Lagos calendar day (UTC+1) an instant falls on, YYYY-MM-DD.
export function lagosDay(instant: Date): string {
  return new Date(instant.getTime() + 3_600_000).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// The Lagos days still to charge: from the day fees start (or the day
// after the last charged one) through today. Empty before fees start.
export function storageDaysDue(
  feesFrom: Date,
  chargedThrough: string | null,
  now: Date,
): string[] {
  if (now < feesFrom) {
    return [];
  }
  const today = lagosDay(now);
  let day = chargedThrough ? addDays(chargedThrough, 1) : lagosDay(feesFrom);
  const days: string[] = [];
  while (day <= today && days.length < 366) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

export function disposeAtFor(feesFrom: Date): Date {
  return new Date(feesFrom.getTime() + DISPOSAL_AFTER_DAYS * DAY_MS);
}
