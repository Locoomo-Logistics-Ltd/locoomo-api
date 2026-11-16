import { BusinessException } from '../../../../common/exceptions';

export class BagNotSealableException extends BusinessException {
  readonly errorCode = 'BAG_NOT_SEALABLE';
  readonly httpStatus = 409;

  constructor(status: string) {
    super(`This bag is ${status}: only an open bag can be sealed`);
    this.details = { status };
  }
}

export class RerouteNotPendingException extends BusinessException {
  readonly errorCode = 'REROUTE_NOT_PENDING';
  readonly httpStatus = 409;

  constructor() {
    super('This parcel isn’t waiting for a new destination');
  }
}

export class RerouteTargetUnavailableException extends BusinessException {
  readonly errorCode = 'REROUTE_TARGET_UNAVAILABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'Pick an active Node with free space (not the parcel’s origin or current destination)',
    );
  }
}
