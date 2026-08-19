import { BusinessException } from '../../../../common/exceptions';

export class RevenueSplitNotConfiguredException extends BusinessException {
  readonly errorCode = 'REVENUE_SPLIT_NOT_CONFIGURED';
  readonly httpStatus = 503;

  constructor() {
    super('No revenue split rule is currently configured');
  }
}
