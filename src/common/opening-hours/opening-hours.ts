import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// A Node's weekly opening hours, in Nigerian local time (Africa/Lagos —
// UTC+1 all year, no DST). A day that's missing or has an empty array is
// closed. Intervals are same-day only (no overnight opening); a day can have
// several, e.g. a lunch break.
//
// Lives in common/ rather than nodes/domain because DTOs in other modules
// (node-operators' onboarding) validate the same shape, and the module
// boundary rule forbids importing another module's domain/.
export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface OpeningInterval {
  open: string; // "HH:mm"
  close: string; // "HH:mm", later than open
}

export type OpeningHours = Partial<Record<Weekday, OpeningInterval[]>>;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_INTERVALS_PER_DAY = 4;
const LAGOS_UTC_OFFSET_MINUTES = 60;

// null when valid, otherwise a human-readable reason (surfaced as the
// validation error message).
export function validateOpeningHours(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be an object keyed by day (mon … sun)';
  }

  for (const [day, intervals] of Object.entries(value)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      return `has unknown day "${day}" (expected ${WEEKDAYS.join(', ')})`;
    }
    if (!Array.isArray(intervals)) {
      return `${day} must be an array of { open, close } intervals`;
    }
    if (intervals.length > MAX_INTERVALS_PER_DAY) {
      return `${day} has more than ${MAX_INTERVALS_PER_DAY} intervals`;
    }

    let previousClose = -1;
    for (const interval of intervals as unknown[]) {
      if (typeof interval !== 'object' || interval === null) {
        return `${day} intervals must be { open, close } objects`;
      }
      const { open, close, ...rest } = interval as Record<string, unknown>;
      if (Object.keys(rest).length > 0) {
        return `${day} intervals only allow open and close`;
      }
      if (
        typeof open !== 'string' ||
        typeof close !== 'string' ||
        !TIME_PATTERN.test(open) ||
        !TIME_PATTERN.test(close)
      ) {
        return `${day} times must be 24-hour HH:mm`;
      }
      const openMinutes = toMinutes(open);
      const closeMinutes = toMinutes(close);
      if (closeMinutes <= openMinutes) {
        return `${day} closes before it opens (${open}–${close}); overnight hours aren't supported`;
      }
      if (openMinutes < previousClose) {
        return `${day} intervals must be in order and not overlap`;
      }
      previousClose = closeMinutes;
    }
  }

  return null;
}

// Whether the Node is open at `at` (any instant; converted to Lagos time).
export function isOpenAt(hours: OpeningHours, at: Date): boolean {
  const lagos = new Date(at.getTime() + LAGOS_UTC_OFFSET_MINUTES * 60_000);
  // getUTCDay: 0 = Sunday … 6 = Saturday.
  const day = WEEKDAYS[(lagos.getUTCDay() + 6) % 7];
  const minutes = lagos.getUTCHours() * 60 + lagos.getUTCMinutes();
  return (hours[day] ?? []).some(
    (interval) =>
      minutes >= toMinutes(interval.open) &&
      minutes < toMinutes(interval.close),
  );
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function IsOpeningHours(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsOpeningHours',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return validateOpeningHours(value) === null;
        },
        defaultMessage(args?: ValidationArguments): string {
          return `${propertyName} ${validateOpeningHours(args?.value) ?? 'is invalid'}`;
        },
      },
    });
  };
}
