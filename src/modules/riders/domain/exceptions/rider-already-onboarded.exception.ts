import { BusinessException } from '../../../../common/exceptions';

export class RiderAlreadyOnboardedException extends BusinessException {
  readonly errorCode = 'RIDER_ALREADY_ONBOARDED';
  readonly httpStatus = 409;

  constructor() {
    super('This account has already completed rider onboarding');
  }
}
