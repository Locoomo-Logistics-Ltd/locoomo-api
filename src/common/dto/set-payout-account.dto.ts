import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Shared by riders' and node-operators' PATCH me/payout-account — identical
// validation needed by both simultaneously. No accountName field: the
// server resolves the real name from Paystack (PaystackBankService), never
// trusts a client-typed one — see SetRiderPayoutAccountService/
// SetNodePayoutAccountService.
export class SetPayoutAccountDto {
  // Paystack bank codes are numeric strings, 3-10 digits in practice.
  @IsString()
  @Matches(/^\d{3,10}$/, { message: 'bankCode must be a numeric bank code' })
  bankCode!: string;

  // Display label only (from the GET /payments/banks list the client
  // already fetched) — not itself verified, only accountNumber+bankCode go
  // to Paystack.
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  bankName!: string;

  // NUBAN — exactly 10 digits.
  @IsString()
  @Matches(/^\d{10}$/, { message: 'accountNumber must be exactly 10 digits' })
  accountNumber!: string;
}
