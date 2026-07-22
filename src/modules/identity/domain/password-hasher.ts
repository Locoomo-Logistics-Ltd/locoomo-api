import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

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
