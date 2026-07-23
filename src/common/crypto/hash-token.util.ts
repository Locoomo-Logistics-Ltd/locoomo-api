import { createHash } from 'crypto';

// Generic SHA-256 digest for hashing high-entropy generated secrets before
// storage (refresh tokens, password-reset tokens, invite tokens) — a slow KDF
// buys nothing on an already-random value. Never use this for human
// passwords (see identity/domain/password-hasher, which uses scrypt).
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
