import {
  AuthorizationException,
  BusinessException,
} from '../../../common/exceptions';

export class SelfApprovalNotAllowedException extends AuthorizationException {
  readonly errorCode = 'SELF_APPROVAL_NOT_ALLOWED';
  readonly httpStatus = 403;

  constructor() {
    super('A different admin must approve a request you created');
  }
}

export class ApprovalNotPendingException extends BusinessException {
  readonly errorCode = 'APPROVAL_NOT_PENDING';
  readonly httpStatus = 409;

  constructor(status: string) {
    super(`This request is already ${status}`);
  }
}

export class UnknownApprovalActionException extends BusinessException {
  readonly errorCode = 'UNKNOWN_APPROVAL_ACTION';
  readonly httpStatus = 400;

  constructor(action: string) {
    super(`Unknown approval action: ${action}`);
  }
}
