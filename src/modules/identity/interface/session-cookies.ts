import { Response } from 'express';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_PATH,
} from '../../../common/auth/session-cookie-names';
import { IssuedSession } from '../application/token-issuance.service';

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE_PATH };

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

// Path must match what the cookie was set with — the browser identifies a
// cookie by name+path+domain, so a mismatched path silently clears nothing.
export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { path: REFRESH_TOKEN_COOKIE_PATH });
}
