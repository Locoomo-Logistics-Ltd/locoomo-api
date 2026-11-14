import { MerchantStatus } from './merchant.enums';

const S = MerchantStatus;

// Every allowed status change (plan §2.1). Anything not listed is refused
// with 409 INVALID_MERCHANT_TRANSITION, so a stale admin screen can't, say,
// approve a merchant someone else already rejected.
const TRANSITIONS: Readonly<Record<MerchantStatus, readonly MerchantStatus[]>> =
  {
    [S.DRAFT]: [S.SUBMITTED, S.SUSPENDED, S.CLOSED],
    [S.SUBMITTED]: [
      S.IN_REVIEW,
      S.APPROVED,
      S.CHANGES_REQUESTED,
      S.REJECTED,
      S.SUSPENDED,
    ],
    [S.IN_REVIEW]: [S.APPROVED, S.CHANGES_REQUESTED, S.REJECTED, S.SUSPENDED],
    [S.CHANGES_REQUESTED]: [S.SUBMITTED, S.SUSPENDED, S.CLOSED],
    [S.APPROVED]: [S.SUSPENDED, S.CLOSED],
    [S.REJECTED]: [S.CLOSED],
    // Reinstating returns to whatever the merchant was before; which one is
    // checked against `statusBeforeSuspension`, not here.
    [S.SUSPENDED]: [
      S.DRAFT,
      S.SUBMITTED,
      S.IN_REVIEW,
      S.CHANGES_REQUESTED,
      S.APPROVED,
    ],
    [S.CLOSED]: [],
  };

export function canTransition(
  from: MerchantStatus,
  to: MerchantStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

// Statuses whose onboarding details the team can still change. While a
// reviewer is looking at a submission it's frozen, so what they approve is
// what was submitted.
export const ONBOARDING_EDITABLE: readonly MerchantStatus[] = [
  S.DRAFT,
  S.CHANGES_REQUESTED,
];

// Once approved, only contact details and the settlement bank account
// (with step-up) can change; identity details (legal name, CAC, directors,
// documents) are locked — changing them means a new review, which goes
// through the account manager.
export const CONTACT_EDITABLE: readonly MerchantStatus[] = [
  ...ONBOARDING_EDITABLE,
  S.APPROVED,
];

export const UNDER_REVIEW: readonly MerchantStatus[] = [
  S.SUBMITTED,
  S.IN_REVIEW,
];
