import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'crypto';

// Authenticated encryption (AES-256-GCM) for small secrets we must be able
// to read back — TOTP seeds today. Hashing isn't an option for those (the
// server needs the seed to compute the expected code), so they're encrypted
// at rest: a database dump alone doesn't let anyone mint 2FA codes.
//
// Format: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>". The version
// prefix leaves room to rotate algorithm/key later without ambiguity.
const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretBox {
  private readonly key: Buffer;

  // `keyMaterial` is any high-entropy string (≥ 32 chars). HKDF with a
  // per-purpose `context` derives the actual key, so one env secret can
  // safely back several independent boxes.
  constructor(keyMaterial: string, context: string) {
    if (keyMaterial.length < 32) {
      throw new Error('SecretBox key material must be at least 32 characters');
    }
    this.key = Buffer.from(
      hkdfSync('sha256', keyMaterial, 'locoomo-secret-box', context, 32),
    );
  }

  seal(plaintext: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, ciphertext]
      .map((part) =>
        typeof part === 'string' ? part : part.toString('base64url'),
      )
      .join('.');
  }

  // Throws if the value was tampered with or sealed under another key.
  open(sealed: string): Buffer {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unrecognised sealed value');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]);
  }
}
