import { BusinessException } from '../../../../common/exceptions';

// Nothing we run can carry this parcel on this route: too big or heavy for
// every enabled vehicle class, or no courier serves that vehicle between
// these Nodes. The sender should change the parcel details or pick other
// Nodes — retrying as-is won't help.
export class NoDeliveryOptionException extends BusinessException {
  readonly errorCode = 'NO_DELIVERY_OPTION';
  readonly httpStatus = 422;

  constructor(reason: string) {
    super(`No delivery option for this parcel: ${reason}`);
  }
}
