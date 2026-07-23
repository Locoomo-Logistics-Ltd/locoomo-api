import { AuthenticationException } from '../../../../common/exceptions';

export class UnauthenticatedException extends AuthenticationException {
  readonly errorCode = 'UNAUTHENTICATED';
  readonly httpStatus = 401;

  constructor() {
    super('Authentication required');
  }
}
