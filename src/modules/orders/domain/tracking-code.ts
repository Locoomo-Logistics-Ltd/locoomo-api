import { randomInt } from 'crypto';

// Crockford Base32 alphabet — excludes 0/O, 1/I/L so a receiver reading this
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'LCM';
const CODE_LENGTH = 8;

export function generateTrackingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${PREFIX}-${code.slice(0, 4)}-${code.slice(4)}`;
}

// Turns whatever an operator typed (often off a handwritten label) or a QR
// decoded into the canonical "LCM-XXXX-XXXX", or null if it can't be one.
// Forgiving the way Crockford Base32 intends: case, spaces and dashes don't
// matter, the LCM prefix is optional, and the characters the alphabet
// deliberately leaves out are read as the digits they get mistaken for
// (O → 0, I/L → 1). A pasted tracking URL (…/track/LCM-…?t=…) works too.
export function normalizeTrackingCode(input: string): string | null {
  let value = input.trim();
  const fromUrl = /\/track\/([^/?#]+)/i.exec(value);
  if (fromUrl) {
    value = decodeURIComponent(fromUrl[1]);
  }

  value = value.toUpperCase().replace(/[\s\-_.]/g, '');
  // Strip the prefix before mapping look-alikes — its L would otherwise
  // become a 1.
  if (
    value.length === PREFIX.length + CODE_LENGTH &&
    value.startsWith(PREFIX)
  ) {
    value = value.slice(PREFIX.length);
  }
  if (value.length !== CODE_LENGTH) {
    return null;
  }

  const body = value.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (![...body].every((char) => ALPHABET.includes(char))) {
    return null;
  }
  return `${PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
}
