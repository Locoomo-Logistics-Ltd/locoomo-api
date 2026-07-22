import { Response } from 'express';
import { IssuedSession } from '../application/token-issuance.service';

export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

// Refresh cookie is scoped so the browser only ever sends it to the one
// endpoint that consumes it — it never rides along on ordinary API calls.
export const REFRESH_TOKEN_COOKIE_PATH = '/api/v1/auth/refresh';

// httpOnly + Secure + SameSite=Strict on both: httpOnly is the only
// mechanism actually immune to XSS token theft; SameSite=Strict plus the
// required custom header on mutating routes
// covers CSRF instead of relying on cookie flags alone.
export function setSessionCookies(
  res: Response,
  session: IssuedSession,
  secure: boolean,
): void {
  res.cookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: session.accessTokenExpiresInSeconds * 1000,
  });

  res.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_TOKEN_COOKIE_PATH,
    expires: session.refreshTokenExpiresAt,
  });
}
