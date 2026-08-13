import { BusinessException } from '../../../../common/exceptions';

// Deliberately generic — missing, expired, already-used, locked-out, and
// wrong-value all collapse into the same response, same enumeration-
// avoidance reasoning as InvalidCredentialsException/InvalidResetTokenException.
export class InvalidHandoffCodeException extends BusinessException {
  readonly errorCode = 'INVALID_HANDOFF_CODE';
  readonly httpStatus = 401;

  constructor() {
    super('Invalid or expired handoff code');
  }
}
