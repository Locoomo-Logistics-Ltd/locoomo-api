import { AuthorizationException } from '../../../../common/exceptions';

// Only reachable after the password has already been verified — so unlike

export class AccountSuspendedException extends AuthorizationException {
  readonly errorCode = 'ACCOUNT_SUSPENDED';
  readonly httpStatus = 403;

  constructor() {
    super('This account has been suspended');
  }
}
