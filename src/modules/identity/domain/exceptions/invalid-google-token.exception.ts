import { AuthenticationException } from '../../../../common/exceptions';

// Covers every way a Google sign-in attempt fails to give us something we
// can trust: bad signature, wrong audience, expired, Google itself reports
// the email as unverified (email_verified !== true — we can no longer treat
// the claimed email as proven), or the token verifies but Google's payload
// doesn't include enough profile info (no given_name/family_name and no
// name to fall back to) to populate a required field.
export class InvalidGoogleTokenException extends AuthenticationException {
  readonly errorCode = 'INVALID_GOOGLE_TOKEN';
  readonly httpStatus = 401;

  constructor() {
    super('Google sign-in could not be completed');
  }
}
