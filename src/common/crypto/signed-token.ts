import { createHash, createHmac, timingSafeEqual } from 'crypto';

// A short-lived, tamper-proof token carrying a small JSON payload: what a
// download link may fetch, for whom, until when. `purpose` separates uses
// (a token for one can't be replayed as another).
export function signToken(
  secret: string,
  purpose: string,
  payload: Record<string, unknown>,
  expiresAt: Date,
): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(expiresAt.getTime() / 1000) }),
  ).toString('base64url');
  return `${body}.${mac(secret, purpose, body)}`;
}

// null when the token is malformed, forged, for another purpose or expired.
export function verifyToken<T extends Record<string, unknown>>(
  secret: string,
  purpose: string,
  token: string,
  now = new Date(),
): T | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) {
    return null;
  }
  const expected = Buffer.from(mac(secret, purpose, body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as T & {
      exp?: number;
    };
    if (
      typeof payload.exp !== 'number' ||
      payload.exp * 1000 <= now.getTime()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function mac(secret: string, purpose: string, body: string): string {
  const key = createHash('sha256')
    .update(`signed-token:${purpose}:${secret}`)
    .digest();
  return createHmac('sha256', key).update(body).digest('base64url');
}
