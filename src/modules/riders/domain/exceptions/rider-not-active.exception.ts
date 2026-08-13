import { BusinessException } from '../../../../common/exceptions';

// Distinct from a plain role check — a User can hold role RIDER while their
// RiderProfile is still `pending` (awaiting Admin approval) or `suspended`.
// Only an `active` profile may accept deliveries.
export class RiderNotActiveException extends BusinessException {
  readonly errorCode = 'RIDER_NOT_ACTIVE';
  readonly httpStatus = 403;

  constructor() {
    super('Your rider account is not yet approved to accept deliveries');
  }
}
