import {
  base32Decode,
  base32Encode,
  hotp,
  totpStep,
  totpUri,
  verifyTotp,
} from './totp';

// RFC 6238 Appendix B secret for SHA-1: ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 SHA-1 vector at T=%i', (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(expected);
  });

  it.each([
    [0, '755224'],
    [1, '287082'],
    [9, '520489'],
  ])('matches the RFC 4226 HOTP vector for counter %i', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter)).toBe(expected);
  });

  it('round-trips base32 (RFC 4648, unpadded)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb oi====').toString()).toBe('foobar');
  });

  describe('verifyTotp', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const codeAt = (s: number): string => hotp(RFC_SECRET, s);

    it('accepts the current code and the adjacent steps', () => {
      expect(verifyTotp(RFC_SECRET, codeAt(step), null, now)).toBe(step);
      expect(verifyTotp(RFC_SECRET, codeAt(step - 1), null, now)).toBe(
        step - 1,
      );
      expect(verifyTotp(RFC_SECRET, codeAt(step + 1), null, now)).toBe(
        step + 1,
      );
    });

    it('rejects codes outside the window and malformed input', () => {
      expect(verifyTotp(RFC_SECRET, codeAt(step - 2), null, now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, '12345', null, now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, 'abcdef', null, now)).toBeNull();
    });

    it('refuses to accept the same code (or an older one) twice', () => {
      expect(verifyTotp(RFC_SECRET, codeAt(step), step, now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, codeAt(step - 1), step, now)).toBeNull();
      expect(verifyTotp(RFC_SECRET, codeAt(step + 1), step, now)).toBe(
        step + 1,
      );
    });
  });

  it('builds an otpauth URI authenticator apps accept', () => {
    const uri = totpUri(Buffer.from('foobar'), 'ada@x.test', 'Locoomo');
    expect(uri).toBe(
      'otpauth://totp/Locoomo%3Aada%40x.test?secret=MZXW6YTBOI&issuer=Locoomo&algorithm=SHA1&digits=6&period=30',
    );
  });
});
