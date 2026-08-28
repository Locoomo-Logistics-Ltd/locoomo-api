import { BusinessException } from '../../../../common/exceptions';

// Only ever thrown on the account-creation branch of
// GoogleAuthService.authenticate — an existing-googleId login never reaches
// this check. NDPA consent must be captured at the moment personal data is
// actually processed (account creation), so it can't be deferred to a later
// step the way phone can.
export class ConsentRequiredException extends BusinessException {
  readonly errorCode = 'CONSENT_REQUIRED';
  readonly httpStatus = 400;

  constructor() {
    super('You must accept the Terms of Service and Privacy Policy');
  }
}
