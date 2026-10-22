import { AuthenticationException } from '../../../../common/exceptions';

// Same code as the payment webhook's — a request that isn't provably from
// the courier is rejected before anything is parsed or stored.
export class InvalidCourierWebhookSignatureException extends AuthenticationException {
  readonly errorCode = 'INVALID_WEBHOOK_SIGNATURE';
  readonly httpStatus = 401;

  constructor(providerKey: string) {
    super(`Invalid ${providerKey} webhook signature`);
  }
}
