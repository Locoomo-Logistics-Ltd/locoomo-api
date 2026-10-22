import { BusinessException } from '../../../../common/exceptions';

// An Admin action that doesn't apply to the delivery (or courier) in its
// current state — e.g. falling back after pickup, retrying one the courier
// already has, disabling the in-house fallback.
export class IllegalDeliveryActionException extends BusinessException {
  readonly errorCode = 'ILLEGAL_DELIVERY_ACTION';
  readonly httpStatus = 409;

  constructor(reason: string) {
    super(reason);
  }
}
