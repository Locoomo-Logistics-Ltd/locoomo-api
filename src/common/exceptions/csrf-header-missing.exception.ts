import { AuthorizationException } from './authorization.exception';

export class CsrfHeaderMissingException extends AuthorizationException {
  readonly errorCode = 'CSRF_HEADER_MISSING';
  readonly httpStatus = 403;

  constructor() {
    super('This request must include the X-Locoomo-Client header');
  }
}
