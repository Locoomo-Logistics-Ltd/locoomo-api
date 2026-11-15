import { BusinessException } from '../../../../common/exceptions';

export class BagNotSealableException extends BusinessException {
  readonly errorCode = 'BAG_NOT_SEALABLE';
  readonly httpStatus = 409;

  constructor(status: string) {
    super(`This bag is ${status}: only an open bag can be sealed`);
    this.details = { status };
  }
}
