// Field names whose values never belong in an audit trail: credentials and
// secrets (can't leak what was never stored) and personal data (NDPA — the
// audit log is retained far longer than the data it describes).
const SENSITIVE_KEY = new RegExp(
  [
    'pass(word)?',
    'secret',
    'token',
    'api_?key',
    'signature',
    'otp',
    // one-time codes: collection/handoff/recovery codes and their hashes
    '^code$',
    'codehash',
    '(collection|handoff|recovery|verification|reset|invite)codes?',
    'bvn',
    '^nin$',
    'id_?number',
    'account_?number',
    'cvv',
    'card_?number',
    'email',
    'phone',
    'address',
    'date_?of_?birth',
    '^dob$',
  ].join('|'),
  'i',
);

// Keys that merely *mention* one of the words above but are safe
// identifiers, labels or timestamps we want to keep.
const ALLOWED_KEY = /^(id|.*Id|.*Ids|.*At|tokenType|codeType)$/;

export const REDACTED = '[REDACTED]';

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redact(item, depth + 1)) as T;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] =
        SENSITIVE_KEY.test(key) && !ALLOWED_KEY.test(key)
          ? REDACTED
          : redact(inner, depth + 1);
    }
    return out as T;
  }
  return value;
}
