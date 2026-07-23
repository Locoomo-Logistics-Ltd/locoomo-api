import { hashToken } from '../../../common/crypto/hash-token.util';

// Thin, semantically-named wrapper — see hashToken for why this isn't scrypt.
export function hashRefreshToken(token: string): string {
  return hashToken(token);
}
