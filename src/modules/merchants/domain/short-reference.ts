import { randomInt } from 'crypto';

// Crockford base32 without I, L, O, U: read off a screen or paper, typed at
// a counter.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// PREFIX-XXXX-XXXX, e.g. RB-7KQ2-M9XD (return batch), MF-3HX9-0QWE (manifest).
export function newShortReference(prefix: string): string {
  const part = (): string =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
      '',
    );
  return `${prefix}-${part()}-${part()}`;
}

// Accepts any case, spaces or no dashes: "rb 7kq2 m9xd", "RB7KQ2M9XD".
export function normaliseShortReference(
  prefix: string,
  input: string,
): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  const match = new RegExp(`^${prefix}([0-9A-Z]{4})([0-9A-Z]{4})$`).exec(
    compact,
  );
  return match ? `${prefix}-${match[1]}-${match[2]}` : null;
}
