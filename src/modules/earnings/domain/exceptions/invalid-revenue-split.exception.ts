import { BusinessException } from '../../../../common/exceptions';

export class InvalidRevenueSplitException extends BusinessException {
  readonly errorCode = 'INVALID_REVENUE_SPLIT';
  readonly httpStatus = 400;

  constructor() {
    super('riderPercent, nodePercent, and platformPercent must sum to 100');
  }
}
