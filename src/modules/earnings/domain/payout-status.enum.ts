export enum PayoutStatus {
  PENDING = 'pending',
  PAID = 'paid',
  // Never paid out to anyone (courier allocations) — excluded from payout
  // work, and mark-paid refuses it.
  NOT_PAYABLE = 'not_payable',
}
