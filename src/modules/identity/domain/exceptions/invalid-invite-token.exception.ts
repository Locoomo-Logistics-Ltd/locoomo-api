import { AuthenticationException } from '../../../../common/exceptions';

export class InvalidInviteTokenException extends AuthenticationException {
  readonly errorCode = 'INVALID_INVITE_TOKEN';
  readonly httpStatus = 401;

  constructor() {
    super('This invitation link is invalid or has expired');
  }
}
