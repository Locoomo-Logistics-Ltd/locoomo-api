import { createHash } from 'crypto';

// Refresh tokens are high-entropy generated secrets, not human passwords —
// a slow KDF (scrypt) buys nothing here and would waste CPU on every refresh.
// A plain SHA-256 digest is the correct tool for hashing an already-random value.
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
