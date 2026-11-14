import {
  AuthorizationException,
  BusinessException,
} from '../../../../common/exceptions';
import { MerchantStatus, ReviewItemKey } from '../merchant.enums';

export class MerchantPlatformDisabledException extends BusinessException {
  readonly errorCode = 'MERCHANT_PLATFORM_DISABLED';
  readonly httpStatus = 503;

  constructor() {
    super(
      'Merchant services are temporarily unavailable. Please try again later.',
    );
  }
}

export class NotAMerchantMemberException extends AuthorizationException {
  readonly errorCode = 'NOT_A_MERCHANT_MEMBER';
  readonly httpStatus = 403;

  constructor() {
    super('You are not part of a merchant account yet');
  }
}

export class MerchantPermissionDeniedException extends AuthorizationException {
  readonly errorCode = 'MERCHANT_PERMISSION_DENIED';
  readonly httpStatus = 403;

  constructor(permission: string) {
    super('Your team role does not allow this');
    this.details = { permission };
  }
}

export class AdminsCannotJoinMerchantsException extends AuthorizationException {
  readonly errorCode = 'ADMINS_CANNOT_JOIN_MERCHANTS';
  readonly httpStatus = 403;

  constructor() {
    super('Locoomo admin accounts cannot create or join a merchant account');
  }
}

export class AlreadyAMerchantMemberException extends BusinessException {
  readonly errorCode = 'ALREADY_A_MERCHANT_MEMBER';
  readonly httpStatus = 409;

  constructor() {
    super('You already belong to a merchant account');
  }
}

export class MerchantNotEditableException extends BusinessException {
  readonly errorCode = 'MERCHANT_NOT_EDITABLE';
  readonly httpStatus = 409;

  constructor(status: MerchantStatus) {
    super(
      status === MerchantStatus.SUBMITTED || status === MerchantStatus.IN_REVIEW
        ? 'Your details are being reviewed and can’t be changed right now'
        : `This can’t be changed while the account is ${status.replace('_', ' ')}`,
    );
    this.details = { status };
  }
}

export class MerchantDetailsLockedException extends BusinessException {
  readonly errorCode = 'MERCHANT_DETAILS_LOCKED';
  readonly httpStatus = 409;

  constructor(fields: string[]) {
    super(
      'Verified business details can’t be changed after approval. Contact your account manager.',
    );
    this.details = { fields };
  }
}

export class InvalidMerchantTransitionException extends BusinessException {
  readonly errorCode = 'INVALID_MERCHANT_TRANSITION';
  readonly httpStatus = 409;

  constructor(from: MerchantStatus, to: MerchantStatus) {
    super(`A ${from.replace('_', ' ')} merchant can’t become ${to}`);
    this.details = { from, to };
  }
}

export class OnboardingIncompleteException extends BusinessException {
  readonly errorCode = 'ONBOARDING_INCOMPLETE';
  readonly httpStatus = 422;

  constructor(sections: { key: ReviewItemKey; missing: string[] }[]) {
    super('Complete every section before submitting');
    this.details = { sections };
  }
}

export class ReviewHasRejectedItemsException extends BusinessException {
  readonly errorCode = 'REVIEW_HAS_REJECTED_ITEMS';
  readonly httpStatus = 409;

  constructor(keys: ReviewItemKey[]) {
    super(
      'Some sections are rejected. Request changes instead, or accept them first.',
    );
    this.details = { keys };
  }
}

export class NoRejectedItemsException extends BusinessException {
  readonly errorCode = 'NO_REJECTED_ITEMS';
  readonly httpStatus = 422;

  constructor() {
    super(
      'Reject at least one section, with a reason, before requesting changes',
    );
  }
}

export class UploadNotFoundException extends BusinessException {
  readonly errorCode = 'UPLOAD_NOT_FOUND';
  readonly httpStatus = 422;

  constructor() {
    super('We couldn’t find that upload. Upload the file again.');
  }
}

export class DirectorLimitReachedException extends BusinessException {
  readonly errorCode = 'DIRECTOR_LIMIT_REACHED';
  readonly httpStatus = 409;

  constructor(limit: number) {
    super(
      limit === 1
        ? 'An individual seller account has one owner. Remove the existing one first.'
        : `You can add up to ${limit} directors`,
    );
    this.details = { limit };
  }
}

export class TermsVersionOutdatedException extends BusinessException {
  readonly errorCode = 'TERMS_VERSION_OUTDATED';
  readonly httpStatus = 409;

  constructor(currentVersion: string) {
    super('The terms have been updated. Review the latest version.');
    this.details = { currentVersion };
  }
}

// Unknown, expired, revoked or already used — one error on purpose.
export class InvalidMerchantInviteException extends BusinessException {
  readonly errorCode = 'INVALID_MERCHANT_INVITE';
  readonly httpStatus = 404;

  constructor() {
    super('This invitation is no longer valid. Ask for a new one.');
  }
}

export class InviteEmailMismatchException extends AuthorizationException {
  readonly errorCode = 'INVITE_EMAIL_MISMATCH';
  readonly httpStatus = 403;

  constructor() {
    super(
      'This invitation was sent to a different email address. Sign in with that address to accept it.',
    );
  }
}

export class AlreadyATeamMemberException extends BusinessException {
  readonly errorCode = 'ALREADY_A_TEAM_MEMBER';
  readonly httpStatus = 409;

  constructor() {
    super('That person is already on your team');
  }
}

export class OwnerRoleProtectedException extends BusinessException {
  readonly errorCode = 'OWNER_ROLE_PROTECTED';
  readonly httpStatus = 409;

  constructor() {
    super(
      'The owner can’t be removed or have their role changed. Transfer ownership first.',
    );
  }
}

export class NotApplicableToIndividualsException extends BusinessException {
  readonly errorCode = 'NOT_APPLICABLE_TO_INDIVIDUALS';
  readonly httpStatus = 422;

  constructor(field: string) {
    super('Individual sellers don’t provide CAC registration');
    this.details = { field };
  }
}
