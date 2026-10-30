import { PaymentProviderException } from './payment-provider.exception';

// The provider answered, and it has no transaction under this reference —
// unlike a plain PaymentProviderException, retrying won't change the answer
// unless the configured key is what's wrong.
export class PaymentReferenceNotFoundException extends PaymentProviderException {
  constructor(provider: string, reference: string) {
    super(provider, 'verify', `reference ${reference} not found`);
  }
}
