import { AuthenticationException } from './authentication.exception';

export class UnauthenticatedException extends AuthenticationException {
  readonly errorCode = 'UNAUTHENTICATED';
  readonly httpStatus = 401;

  constructor() {
    super('Authentication required');
  }
}
