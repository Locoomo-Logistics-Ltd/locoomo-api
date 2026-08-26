import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../../config/env.validation';
import { BankAccountVerificationFailedException } from '../domain/exceptions/bank-account-verification-failed.exception';
import { PaymentProviderException } from '../domain/exceptions/payment-provider.exception';

export interface BankOption {
  code: string;
  name: string;
}

export interface ResolvedBankAccount {
  accountName: string;
}

interface PaystackListBanksResponse {
  status: boolean;
  message: string;
  data: { name: string; code: string }[];
}

interface PaystackResolveAccountResponse {
  status: boolean;
  message: string;
  data: { account_number: string; account_name: string };
}

// Lives in application/, not infrastructure/, specifically so
// riders/node-operators can import it cross-module without violating the
// no-cross-module-internals boundary rule (.dependency-cruiser.cjs) — same
// treatment as NodesService/RiderCapacityService/UserLookupService. Separate
// from PaymentProvider (payment-provider.port.ts) deliberately — that port
// models "being a payment processor for checkout"
// (initialize/verify/refund/webhook); bank listing/resolution is a
// different Paystack API surface with no near-term second-provider need, so
// no port/interface here either — same reasoning CloudinaryService has none
// (one deliberate vendor, no speculative abstraction). Plain fetch, no SDK,
// same pattern as PaystackPaymentProvider.
@Injectable()
export class PaystackBankService {
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(private readonly configService: ConfigService<Env, true>) {}

  private get secretKey(): string {
    return this.configService.get('PAYSTACK_SECRET_KEY', { infer: true });
  }

  async listBanks(): Promise<BankOption[]> {
    const response = await fetch(
      `${this.baseUrl}/bank?currency=NGN&country=nigeria`,
      { headers: { Authorization: `Bearer ${this.secretKey}` } },
    );

    const body = (await response.json()) as PaystackListBanksResponse;
    if (!response.ok || !body.status) {
      throw new PaymentProviderException(
        'paystack',
        'listBanks',
        body.message ?? `HTTP ${response.status}`,
      );
    }

    return body.data.map((bank) => ({ code: bank.code, name: bank.name }));
  }

  // Called at PATCH me/payout-account submission time — the only way an
  // accountName ever gets stored (see SetRiderPayoutAccountService/
  // SetNodePayoutAccountService), never client-typed.
  async resolveAccountNumber(
    bankCode: string,
    accountNumber: string,
  ): Promise<ResolvedBankAccount> {
    const response = await fetch(
      `${this.baseUrl}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${this.secretKey}` } },
    );

    const body = (await response.json()) as PaystackResolveAccountResponse;
    if (!body.status) {
      // Paystack's own "could not resolve" business response — distinct
      // from a transport/API failure below.
      throw new BankAccountVerificationFailedException(
        body.message ?? 'account could not be resolved',
      );
    }
    if (!response.ok) {
      throw new PaymentProviderException(
        'paystack',
        'resolveAccountNumber',
        `HTTP ${response.status}`,
      );
    }

    return { accountName: body.data.account_name };
  }
}
