import { signToken, verifyToken } from './signed-token';

describe('signed tokens', () => {
  const secret = 'x'.repeat(40);
  const exp = new Date(Date.now() + 60_000);

  it('round-trips, and refuses tampering, other purposes and expiry', () => {
    const token = signToken(secret, 'export', { m: 'abc' }, exp);
    expect(verifyToken(secret, 'export', token)).toMatchObject({ m: 'abc' });
    expect(verifyToken(secret, 'other', token)).toBeNull();
    const [body, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ m: 'evil', exp: 9e9 }),
    ).toString('base64url');
    expect(verifyToken(secret, 'export', `${forged}.${sig}`)).toBeNull();
    expect(verifyToken(secret, 'export', `${body}.${sig}x`)).toBeNull();
    expect(
      verifyToken(secret, 'export', token, new Date(exp.getTime() + 1000)),
    ).toBeNull();
    expect(verifyToken(secret, 'export', 'garbage')).toBeNull();
  });
});
