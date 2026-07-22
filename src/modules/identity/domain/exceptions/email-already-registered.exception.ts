import { BusinessException } from '../../../../common/exceptions';

export class EmailAlreadyRegisteredException extends BusinessException {
  readonly errorCode = 'EMAIL_ALREADY_REGISTERED';
  readonly httpStatus = 409;

  constructor(email: string) {
    super('An account with this email already exists', { email });
  }
}
