import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — the profile every authenticator
// app (Google Authenticator, Authy, 1Password, Microsoft Authenticator)
// supports. Implemented here rather than via a library: it's ~60 lines,
// fully covered by the RFC's own test vectors (totp.spec.ts), and keeps a
// security-critical dependency out of the tree.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
// Accept the previous and next step too — phone clocks drift and people
// type slowly. Wider windows make guessing easier for no real benefit.
export const TOTP_WINDOW_STEPS = 1;
// 160-bit secrets, as RFC 4226 recommends for HMAC-SHA1.
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

// RFC 4648 base32 without padding — the format authenticator apps expect
// in otpauth:// URIs and for manual entry.
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

// RFC 4226 HOTP with dynamic truncation.
export function hotp(
  secret: Buffer,
  counter: number,
  digits: number = TOTP_DIGITS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

// Returns the matching time step (so the caller can store it and refuse to
// accept the same code twice), or null when the code doesn't match.
// `notAfterStep`: the last step already used — codes from that step or
// earlier are rejected (replay protection).
export function verifyTotp(
  secret: Buffer,
  code: string,
  notAfterStep: number | null,
  atMs: number = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const current = totpStep(atMs);
  for (
    let step = current - TOTP_WINDOW_STEPS;
    step <= current + TOTP_WINDOW_STEPS;
    step++
  ) {
    if (notAfterStep !== null && step <= notAfterStep) {
      continue;
    }
    const expected = hotp(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return step;
    }
  }
  return null;
}

export function totpUri(
  secret: Buffer,
  accountName: string,
  issuer: string,
): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
