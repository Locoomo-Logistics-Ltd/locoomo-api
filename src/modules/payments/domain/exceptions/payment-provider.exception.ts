import { InfrastructureException } from '../../../../common/exceptions';

export class PaymentProviderException extends InfrastructureException {
  readonly errorCode = 'PAYMENT_PROVIDER_ERROR';
  readonly httpStatus = 502;

  constructor(provider: string, operation: string, detail: string) {
    super(`${provider} ${operation} failed: ${detail}`, {
      provider,
      operation,
    });
  }
}
