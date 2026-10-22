import { BusinessException } from '../../../../common/exceptions';

// A courier allocation — recorded for reporting, never paid to anyone.
export class RevenueSplitNotPayableException extends BusinessException {
  readonly errorCode = 'REVENUE_SPLIT_NOT_PAYABLE';
  readonly httpStatus = 409;

  constructor(entryId: string) {
    super(`Revenue split entry ${entryId} is not payable`, { entryId });
  }
}
