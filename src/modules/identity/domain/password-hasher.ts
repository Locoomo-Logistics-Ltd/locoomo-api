import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

// Node's crypto.scrypt defaults (N=16384, r=8, p=1, ~16MB working memory per
// hash) already match OWASP's minimum-acceptable scrypt configuration.
// Deliberately not using OWASP's stronger recommended default (N=131072,
// ~128MB) — that's too much working memory per concurrent login on a
// free-tier deployment target with limited total RAM. Zero new dependency
// either way: this is Node's built-in crypto, not bcrypt/argon2.
export async function hashPassword(plainPassword: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = (await scryptAsync(
    plainPassword,
    salt,
    KEY_LENGTH,
  )) as Buffer;
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(
  plainPassword: string,
  storedHash: string,
): Promise<boolean> {
  const [saltHex, keyHex] = storedHash.split(':');
  if (!saltHex || !keyHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const storedKey = Buffer.from(keyHex, 'hex');
  // Derive to storedKey's own length so the two buffers timingSafeEqual
  // compares are always equal-length — never throws on a malformed hash.
  const derivedKey = (await scryptAsync(
    plainPassword,
    salt,
    storedKey.length,
  )) as Buffer;

  return timingSafeEqual(derivedKey, storedKey);
}
