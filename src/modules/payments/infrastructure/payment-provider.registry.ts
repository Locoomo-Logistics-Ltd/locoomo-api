import { Injectable } from '@nestjs/common';
import { PaymentProviderName } from '../domain/payment-provider-name.enum';
import { PaymentProvider } from '../domain/ports/payment-provider.port';
import { PaystackPaymentProvider } from './paystack-payment-provider';

@Injectable()
export class PaymentProviderRegistry {
  private readonly providers = new Map<PaymentProviderName, PaymentProvider>();

  constructor(paystackPaymentProvider: PaystackPaymentProvider) {
    this.providers.set(PaymentProviderName.PAYSTACK, paystackPaymentProvider);
  }

  get(provider: PaymentProviderName): PaymentProvider {
    const found = this.providers.get(provider);
    if (!found) {
      throw new Error(`No PaymentProvider registered for ${provider}`);
    }
    return found;
  }
}
