import { AuthenticationException } from '../../../../common/exceptions';

// Signature missing or doesn't match — either a forged request or a
// misconfigured secret. Rejected outright, never processed.
export class InvalidWebhookSignatureException extends AuthenticationException {
  readonly errorCode = 'INVALID_WEBHOOK_SIGNATURE';
  readonly httpStatus = 401;

  constructor(provider: string) {
    super(`Invalid webhook signature for provider ${provider}`, {
      provider,
    });
  }
}
