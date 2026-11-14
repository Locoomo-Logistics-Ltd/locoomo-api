import { AuthorizationException } from './authorization.exception';

export class ReauthRequiredException extends AuthorizationException {
  readonly errorCode = 'REAUTH_REQUIRED';
  readonly httpStatus = 403;

  constructor() {
    super('Confirm it’s you to continue');
  }
}
