import { BusinessException } from '../../../../common/exceptions';

// Lives here, not in riders/domain — same reasoning as
// NodeCapacityUnavailableException living in payments/domain rather than
// nodes/domain: the module that owns the reject decision for its own
// action, not the module that owns the counted resource.
export class RiderCapacityUnavailableException extends BusinessException {
  readonly errorCode = 'RIDER_CAPACITY_UNAVAILABLE';
  readonly httpStatus = 409;

  constructor(riderId: string) {
    super(
      `Rider ${riderId} already has the maximum number of active deliveries`,
      {
        riderId,
      },
    );
  }
}
