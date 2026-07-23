import { AuthenticationException } from '../../../../common/exceptions';

export class InvalidResetTokenException extends AuthenticationException {
  readonly errorCode = 'INVALID_RESET_TOKEN';
  readonly httpStatus = 401;

  constructor() {
    super('This password reset link is invalid or has expired');
  }
}
