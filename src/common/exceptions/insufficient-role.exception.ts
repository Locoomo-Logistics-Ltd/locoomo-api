import { AuthorizationException } from './authorization.exception';

export class InsufficientRoleException extends AuthorizationException {
  readonly errorCode = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('You do not have permission to perform this action');
  }
}
