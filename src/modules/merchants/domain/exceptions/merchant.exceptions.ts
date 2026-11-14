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

export class MerchantNotApprovedException extends AuthorizationException {
  readonly errorCode = 'MERCHANT_NOT_APPROVED';
  readonly httpStatus = 403;

  constructor() {
    super(
      'Live mode needs an approved merchant account. Use test mode until then.',
    );
  }
}

export class MerchantSuspendedException extends AuthorizationException {
  readonly errorCode = 'MERCHANT_SUSPENDED';
  readonly httpStatus = 403;

  constructor() {
    super(
      'This merchant account is suspended. Reads still work and parcels in flight continue.',
    );
  }
}

export class MfaRequiredForLiveKeysException extends AuthorizationException {
  readonly errorCode = 'MFA_REQUIRED_FOR_LIVE_KEYS';
  readonly httpStatus = 403;

  constructor(who: 'you' | 'owner') {
    super(
      who === 'you'
        ? 'Turn on two-factor authentication on your account to manage live keys'
        : 'The account owner must turn on two-factor authentication before live keys can be created',
    );
    this.details = { who };
  }
}

export class ApiKeyLimitReachedException extends BusinessException {
  readonly errorCode = 'API_KEY_LIMIT_REACHED';
  readonly httpStatus = 409;

  constructor(limit: number) {
    super(
      `You can have up to ${limit} active keys per mode. Revoke one first.`,
    );
    this.details = { limit };
  }
}

export class ApiKeyRevokedException extends BusinessException {
  readonly errorCode = 'API_KEY_REVOKED';
  readonly httpStatus = 409;

  constructor() {
    super('This key is revoked or expired');
  }
}

export class OriginRequiredException extends BusinessException {
  readonly errorCode = 'ORIGIN_REQUIRED';
  readonly httpStatus = 422;

  constructor() {
    super(
      'Pass originNodeId (where you will drop the parcel). It becomes optional once a hub is assigned to your account.',
    );
  }
}

export class InvalidModeException extends BusinessException {
  readonly errorCode = 'INVALID_MODE';
  readonly httpStatus = 400;

  constructor() {
    super('The Locoomo-Mode header must be "test" or "live"');
  }
}

export class LiveShipmentsNotAvailableException extends AuthorizationException {
  readonly errorCode = 'LIVE_SHIPMENTS_NOT_AVAILABLE';
  readonly httpStatus = 403;

  constructor() {
    super(
      'Live shipments open with the wallet release. Use test mode until then.',
    );
  }
}

export class DuplicateReferenceException extends BusinessException {
  readonly errorCode = 'DUPLICATE_REFERENCE';
  readonly httpStatus = 409;

  constructor(existingShipmentId: string) {
    super('A shipment with this reference already exists in this mode');
    this.details = { existingShipmentId };
  }
}

export class DestinationNodeUnavailableException extends BusinessException {
  readonly errorCode = 'DESTINATION_NODE_UNAVAILABLE';
  readonly httpStatus = 422;

  constructor() {
    super('That Node isn’t accepting parcels. Pick another from GET /nodes.');
  }
}

export class OriginNodeUnavailableException extends BusinessException {
  readonly errorCode = 'ORIGIN_NODE_UNAVAILABLE';
  readonly httpStatus = 422;

  constructor() {
    super('The origin Node isn’t available for drop-off. Pick another.');
  }
}

export class ReceiverUnreachableException extends BusinessException {
  readonly errorCode = 'RECEIVER_UNREACHABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'We can’t reach this receiver: add receiver.email, or relay the collection code yourself (notifyReceiver).',
    );
  }
}

export class ReceiverRelayNotEnabledException extends BusinessException {
  readonly errorCode = 'RECEIVER_RELAY_NOT_ENABLED';
  readonly httpStatus = 422;

  constructor() {
    super(
      'Relaying collection codes (notifyReceiver: merchant or both) must be enabled on your account first. Ask your account manager.',
    );
  }
}

export class InsufficientWalletBalanceException extends BusinessException {
  readonly errorCode = 'INSUFFICIENT_WALLET_BALANCE';
  readonly httpStatus = 402;

  constructor(requiredKobo: number, availableKobo: number) {
    super('Your wallet balance is too low for this shipment');
    this.details = { requiredKobo, availableKobo };
  }
}

export class ShipmentNotCancellableException extends BusinessException {
  readonly errorCode = 'SHIPMENT_NOT_CANCELLABLE';
  readonly httpStatus = 409;

  constructor(status: string) {
    super(
      'Only shipments not yet dropped off can be cancelled. Use return-to-sender instead.',
    );
    this.details = { status };
  }
}

export class ShipmentNotEditableException extends BusinessException {
  readonly errorCode = 'SHIPMENT_NOT_EDITABLE';
  readonly httpStatus = 409;

  constructor(field: string, status: string) {
    super(`${field} can’t be changed while the shipment is ${status}`);
    this.details = { field, status };
  }
}

export class ShipmentNotReturnableException extends BusinessException {
  readonly errorCode = 'SHIPMENT_NOT_RETURNABLE';
  readonly httpStatus = 409;

  constructor(status: string) {
    super(
      'Return to sender is possible from received until ready_for_collection',
    );
    this.details = { status };
  }
}

export class TestModeOnlyException extends BusinessException {
  readonly errorCode = 'TEST_MODE_ONLY';
  readonly httpStatus = 403;

  constructor() {
    super(
      'The simulator only works on test shipments (use a test key or Locoomo-Mode: test)',
    );
  }
}

export class InvalidSimulationException extends BusinessException {
  readonly errorCode = 'INVALID_SIMULATION';
  readonly httpStatus = 409;

  constructor(from: string, to: string) {
    super(`A ${from} shipment can’t be simulated to ${to}`);
    this.details = { from, to };
  }
}

export class InvalidWebhookUrlException extends BusinessException {
  readonly errorCode = 'INVALID_WEBHOOK_URL';
  readonly httpStatus = 422;

  constructor(problem: string) {
    super(`Webhook ${problem}`);
  }
}

export class WebhookEndpointLimitReachedException extends BusinessException {
  readonly errorCode = 'WEBHOOK_ENDPOINT_LIMIT_REACHED';
  readonly httpStatus = 409;

  constructor(limit: number) {
    super(`You can have up to ${limit} webhook endpoints per mode`);
    this.details = { limit };
  }
}

export class ReplayWindowExceededException extends BusinessException {
  readonly errorCode = 'REPLAY_WINDOW_EXCEEDED';
  readonly httpStatus = 422;

  constructor(days: number) {
    super(`Events are kept for ${days} days; replay from within that window`);
    this.details = { days };
  }
}
