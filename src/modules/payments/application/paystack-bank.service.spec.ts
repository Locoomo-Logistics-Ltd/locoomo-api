import { ConfigService } from '@nestjs/config';
import { Env } from '../../../config/env.validation';
import { BankAccountVerificationFailedException } from '../domain/exceptions/bank-account-verification-failed.exception';
import { PaymentProviderException } from '../domain/exceptions/payment-provider.exception';
import { PaystackBankService } from './paystack-bank.service';

describe('PaystackBankService.resolveAccountNumber', () => {
  const configService = {
    get: jest.fn(() => 'sk_test_key'),
  } as unknown as ConfigService<Env, true>;
  let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;
  const service = new PaystackBankService(configService);

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns the resolved account name', async () => {
    fetchSpy.mockResolvedValue(
      Response.json({
        status: true,
        message: 'Account number resolved',
        data: { account_number: '0123456789', account_name: 'ADA OBI' },
      }),
    );

    await expect(
      service.resolveAccountNumber('058', '0123456789'),
    ).resolves.toEqual({ accountName: 'ADA OBI' });
  });

  it("reports Paystack's 'could not resolve' answer as a verification failure", async () => {
    fetchSpy.mockResolvedValue(
      Response.json(
        { status: false, message: 'Could not resolve account name' },
        { status: 422 },
      ),
    );

    await expect(
      service.resolveAccountNumber('058', '0123456789'),
    ).rejects.toBeInstanceOf(BankAccountVerificationFailedException);
  });

  it('reports a Paystack outage as a provider error, not as bad account details', async () => {
    // Paystack also answers status:false when it is the one failing.
    fetchSpy.mockResolvedValue(
      Response.json(
        { status: false, message: 'Service unavailable' },
        { status: 503 },
      ),
    );

    await expect(
      service.resolveAccountNumber('058', '0123456789'),
    ).rejects.toBeInstanceOf(PaymentProviderException);
  });
});
