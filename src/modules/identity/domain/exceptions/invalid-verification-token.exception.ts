import { AuthenticationException } from '../../../../common/exceptions';

// Deliberately identical whether the token doesn't exist, is expired, or was
// already used — same enumeration-avoidance reasoning as
// InvalidResetTokenException.
export class InvalidVerificationTokenException extends AuthenticationException {
  readonly errorCode = 'INVALID_VERIFICATION_TOKEN';
  readonly httpStatus = 401;

  constructor() {
    super('This email verification link is invalid or has expired');
  }
}
