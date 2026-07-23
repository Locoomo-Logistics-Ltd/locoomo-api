import { AuthenticationException } from '../../../../common/exceptions';

// Deliberately identical whether the cookie is missing, the token isn't
// recognized, it's expired, or it was already rotated (replay/theft) — same
// reasoning as InvalidCredentialsException: don't hand an attacker a signal
// about which case they hit.
export class InvalidRefreshTokenException extends AuthenticationException {
  readonly errorCode = 'INVALID_REFRESH_TOKEN';
  readonly httpStatus = 401;

  constructor() {
    super('Invalid or expired session');
  }
}
