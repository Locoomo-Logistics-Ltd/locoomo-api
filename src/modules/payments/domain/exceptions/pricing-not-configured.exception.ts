import { BusinessException } from '../../../../common/exceptions';

export class PricingNotConfiguredException extends BusinessException {
  readonly errorCode = 'PRICING_NOT_CONFIGURED';
  readonly httpStatus = 503;

  constructor() {
    super('No pricing rule is currently configured');
  }
}
