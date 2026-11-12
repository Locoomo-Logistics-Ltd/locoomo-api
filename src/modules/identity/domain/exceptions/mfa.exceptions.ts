import {
  AuthenticationException,
  AuthorizationException,
  BusinessException,
} from '../../../../common/exceptions';

export class InvalidMfaCodeException extends AuthenticationException {
  readonly errorCode = 'INVALID_MFA_CODE';
  readonly httpStatus = 401;

  constructor() {
    super(
      'That code is not valid. Check your authenticator app and try again.',
    );
  }
}

// Unknown, expired, already used, or out of attempts — deliberately one
// error; the user just signs in again.
export class InvalidMfaChallengeException extends AuthenticationException {
  readonly errorCode = 'INVALID_MFA_CHALLENGE';
  readonly httpStatus = 401;

  constructor() {
    super('This sign-in attempt has expired. Please sign in again.');
  }
}

export class MfaAlreadyEnabledException extends BusinessException {
  readonly errorCode = 'MFA_ALREADY_ENABLED';
  readonly httpStatus = 409;

  constructor() {
    super('Two-factor authentication is already on for this account');
  }
}

export class MfaNotEnabledException extends BusinessException {
  readonly errorCode = 'MFA_NOT_ENABLED';
  readonly httpStatus = 409;

  constructor() {
    super('Two-factor authentication is not on for this account');
  }
}

export class MfaSetupNotStartedException extends BusinessException {
  readonly errorCode = 'MFA_SETUP_NOT_STARTED';
  readonly httpStatus = 409;

  constructor() {
    super('Start two-factor setup first');
  }
}

export class MfaRequiredForRoleException extends AuthorizationException {
  readonly errorCode = 'MFA_REQUIRED_FOR_ROLE';
  readonly httpStatus = 403;

  constructor() {
    super(
      'Two-factor authentication is mandatory for this account and cannot be turned off',
    );
  }
}

export class MfaEnrollmentRequiredException extends AuthorizationException {
  readonly errorCode = 'MFA_ENROLLMENT_REQUIRED';
  readonly httpStatus = 403;

  constructor() {
    super('Set up two-factor authentication to continue');
  }
}

export class ReauthRequiredException extends AuthorizationException {
  readonly errorCode = 'REAUTH_REQUIRED';
  readonly httpStatus = 403;

  constructor() {
    super('Confirm it’s you to continue');
  }
}

export class EmailAlreadyVerifiedException extends BusinessException {
  readonly errorCode = 'EMAIL_ALREADY_VERIFIED';
  readonly httpStatus = 409;

  constructor() {
    super('This email address is already verified');
  }
}

export class EmailNotVerifiedException extends AuthorizationException {
  readonly errorCode = 'EMAIL_NOT_VERIFIED';
  readonly httpStatus = 403;

  constructor() {
    super('Verify your email address to continue');
  }
}
