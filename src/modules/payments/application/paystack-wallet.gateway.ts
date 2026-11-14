import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Env } from '../../../config/env.validation';
import { PaymentProviderException } from '../domain/exceptions/payment-provider.exception';
import {
  PAYSTACK_READ_POLICY,
  PAYSTACK_WRITE_POLICY,
  paystackRequest,
} from '../infrastructure/paystack-http';

// Which Paystack key a call uses. Merchant live wallets use the main key;
// merchant test wallets use a test key (plan §8.2).
export type PaystackKeyEnv = 'live' | 'test';

export interface WalletCharge {
  reference: string;
  status: 'success' | 'failed' | 'pending';
  amountKobo: number;
  // Paystack's processing fee on this charge, in kobo.
  feeKobo: number;
  channel: string | null;
  customerCode: string | null;
  paidAt: Date | null;
}

export interface PaystackCustomer {
  customerCode: string;
  customerId: number;
}

export interface PaystackDedicatedAccount {
  providerAccountId: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankSlug: string;
}

interface PaystackTransactionData {
  reference: string;
  status: string;
  amount: number;
  fees?: number | null;
  channel?: string | null;
  paid_at?: string | null;
  paidAt?: string | null;
  customer?: { customer_code?: string } | null;
}

const toCharge = (data: PaystackTransactionData): WalletCharge => ({
  reference: data.reference,
  status:
    data.status === 'success'
      ? 'success'
      : data.status === 'failed' || data.status === 'abandoned'
        ? 'failed'
        : 'pending',
  amountKobo: data.amount,
  feeKobo: data.fees ?? 0,
  channel: data.channel ?? null,
  customerCode: data.customer?.customer_code ?? null,
  paidAt:
    (data.paid_at ?? data.paidAt)
      ? new Date((data.paid_at ?? data.paidAt)!)
      : null,
});

// Paystack calls for merchant wallets: card top-ups, customers, Dedicated
// Virtual Accounts (bank-transfer top-ups) and transaction listing for the
// sweep. Lives in payments (the only module that talks to Paystack) and is
// exported for the merchants module; consumer checkout keeps using
// PaystackPaymentProvider.
@Injectable()
export class PaystackWalletGateway {
  constructor(private readonly config: ConfigService<Env, true>) {}

  // Null when this environment has no usable key.
  keyFor(env: PaystackKeyEnv): string | null {
    const main = this.config.get('PAYSTACK_SECRET_KEY', { infer: true });
    if (env === 'live') {
      return main;
    }
    const test: string | undefined = this.config.get(
      'PAYSTACK_TEST_SECRET_KEY',
      { infer: true },
    );
    return test || (main.startsWith('sk_test_') ? main : null);
  }

  isAvailable(env: PaystackKeyEnv): boolean {
    return this.keyFor(env) !== null;
  }

  // A webhook signed with the test key (production only receives these
  // when PAYSTACK_TEST_SECRET_KEY is set). The main key is checked by the
  // payment provider.
  isTestKeySignature(rawBody: Buffer, signature: string | undefined): boolean {
    const test: string | undefined = this.config.get(
      'PAYSTACK_TEST_SECRET_KEY',
      { infer: true },
    );
    if (!test || !signature) {
      return false;
    }
    const expected = Buffer.from(
      createHmac('sha512', test).update(rawBody).digest('hex'),
      'utf8',
    );
    const actual = Buffer.from(signature, 'utf8');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  preferredBank(): string {
    const configured: string | undefined = this.config.get(
      'PAYSTACK_DVA_PREFERRED_BANK',
      { infer: true },
    );
    if (configured) {
      return configured;
    }
    return this.keyFor('live')!.startsWith('sk_test_')
      ? 'test-bank'
      : 'wema-bank';
  }

  async initializeCardTopUp(
    env: PaystackKeyEnv,
    input: {
      reference: string;
      amountKobo: number;
      email: string;
      callbackUrl: string;
      merchantId: string;
      mode: string;
    },
  ): Promise<{ authorizationUrl: string }> {
    const { response, body } = await paystackRequest<{
      status: boolean;
      message?: string;
      data: { authorization_url: string };
    }>(
      'wallet_initialize',
      '/transaction/initialize',
      this.post(env, {
        email: input.email,
        amount: input.amountKobo,
        reference: input.reference,
        callback_url: input.callbackUrl,
        currency: 'NGN',
        channels: ['card', 'bank', 'ussd', 'bank_transfer'],
        // Non-PII identifiers only (NDPA), as for consumer checkout.
        metadata: {
          kind: 'merchant_wallet_top_up',
          merchant_id: input.merchantId,
          mode: input.mode,
        },
      }),
      PAYSTACK_WRITE_POLICY,
    );
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'wallet_initialize',
        body.message ?? `HTTP ${response.status}`,
      );
    }
    return { authorizationUrl: body.data.authorization_url };
  }

  // Null when Paystack has no such transaction (never paid / abandoned
  // before the payment page loaded).
  async verify(
    env: PaystackKeyEnv,
    reference: string,
  ): Promise<WalletCharge | null> {
    const { response, body } = await paystackRequest<{
      status: boolean;
      message?: string;
      code?: string;
      data: PaystackTransactionData;
    }>(
      'wallet_verify',
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: this.auth(env) },
      PAYSTACK_READ_POLICY,
    );
    if (body.code === 'transaction_not_found' || response.status === 404) {
      return null;
    }
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'wallet_verify',
        body.message ?? `HTTP ${response.status}`,
      );
    }
    return toCharge(body.data);
  }

  // Creating a customer with an existing email returns that customer.
  async createCustomer(
    env: PaystackKeyEnv,
    input: {
      email: string;
      firstName: string;
      lastName: string;
      phone: string;
    },
  ): Promise<PaystackCustomer> {
    const { response, body } = await paystackRequest<{
      status: boolean;
      message?: string;
      data: { customer_code: string; id: number };
    }>(
      'create_customer',
      '/customer',
      this.post(env, {
        email: input.email,
        first_name: input.firstName,
        last_name: input.lastName,
        phone: input.phone,
      }),
      PAYSTACK_WRITE_POLICY,
    );
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'create_customer',
        body.message ?? `HTTP ${response.status}`,
      );
    }
    return { customerCode: body.data.customer_code, customerId: body.data.id };
  }

  async createDedicatedAccount(
    env: PaystackKeyEnv,
    customerCode: string,
  ): Promise<PaystackDedicatedAccount> {
    const { response, body } = await paystackRequest<{
      status: boolean;
      message?: string;
      data: {
        id: number;
        account_name: string;
        account_number: string;
        bank: { name: string; slug: string };
      };
    }>(
      'create_dedicated_account',
      '/dedicated_account',
      this.post(env, {
        customer: customerCode,
        preferred_bank: this.preferredBank(),
      }),
      PAYSTACK_WRITE_POLICY,
    );
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'create_dedicated_account',
        body.message ?? `HTTP ${response.status}`,
      );
    }
    return {
      providerAccountId: String(body.data.id),
      accountNumber: body.data.account_number,
      accountName: body.data.account_name,
      bankName: body.data.bank.name,
      bankSlug: body.data.bank.slug,
    };
  }

  // Successful transactions for one customer since `from` (the sweep).
  async successfulCharges(
    env: PaystackKeyEnv,
    customerId: number,
    from: Date,
  ): Promise<WalletCharge[]> {
    const charges: WalletCharge[] = [];
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({
        customer: String(customerId),
        status: 'success',
        from: from.toISOString(),
        perPage: '100',
        page: String(page),
      });
      const { response, body } = await paystackRequest<{
        status: boolean;
        message?: string;
        data: PaystackTransactionData[];
        meta?: { pageCount?: number };
      }>(
        'list_transactions',
        `/transaction?${query.toString()}`,
        { headers: this.auth(env) },
        PAYSTACK_READ_POLICY,
      );
      if (!response.ok || !body.status) {
        throw new PaymentProviderException(
          'paystack',
          'list_transactions',
          body.message ?? `HTTP ${response.status}`,
        );
      }
      charges.push(...body.data.map(toCharge));
      if (body.data.length < 100 || page >= (body.meta?.pageCount ?? page)) {
        break;
      }
    }
    return charges;
  }

  private auth(env: PaystackKeyEnv): Record<string, string> {
    const key = this.keyFor(env);
    if (!key) {
      throw new PaymentProviderException(
        'paystack',
        'wallet',
        `no Paystack key configured for ${env} mode`,
      );
    }
    return { Authorization: `Bearer ${key}` };
  }

  private post(env: PaystackKeyEnv, payload: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { ...this.auth(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }
}
