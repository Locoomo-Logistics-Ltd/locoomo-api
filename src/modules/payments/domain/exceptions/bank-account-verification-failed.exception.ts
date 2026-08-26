import { BusinessException } from '../../../../common/exceptions';

// Paystack's own business response for "this account number doesn't
// resolve at this bank" (status: false) — distinct from
// PaymentProviderException (502), which is for a genuine transport/API
// failure. Nothing gets persisted when this is thrown — see
// SetRiderPayoutAccountService/SetNodePayoutAccountService.
export class BankAccountVerificationFailedException extends BusinessException {
  readonly errorCode = 'BANK_ACCOUNT_VERIFICATION_FAILED';
  readonly httpStatus = 400;

  constructor(detail: string) {
    super(`Bank account verification failed: ${detail}`);
  }
}
