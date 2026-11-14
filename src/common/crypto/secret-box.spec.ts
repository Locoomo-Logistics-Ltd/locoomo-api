import { SecretBox } from './secret-box';

const KEY = 'k'.repeat(64);

describe('SecretBox', () => {
  it('round-trips a secret and never stores it in the clear', () => {
    const box = new SecretBox(KEY, 'totp');
    const secret = Buffer.from('super-secret-seed');
    const sealed = box.seal(secret);
    expect(sealed).not.toContain('super-secret-seed');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(box.open(sealed).equals(secret)).toBe(true);
  });

  it('uses a fresh IV per seal', () => {
    const box = new SecretBox(KEY, 'totp');
    const secret = Buffer.from('x');
    expect(box.seal(secret)).not.toBe(box.seal(secret));
  });

  it('rejects tampering and values sealed under another key or context', () => {
    const box = new SecretBox(KEY, 'totp');
    const sealed = box.seal(Buffer.from('seed'));
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox('z'.repeat(64), 'totp').open(sealed)).toThrow();
    expect(() => new SecretBox(KEY, 'other').open(sealed)).toThrow();
  });

  it('refuses weak key material', () => {
    expect(() => new SecretBox('short', 'totp')).toThrow();
  });
});
