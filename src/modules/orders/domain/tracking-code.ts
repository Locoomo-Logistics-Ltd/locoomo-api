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
