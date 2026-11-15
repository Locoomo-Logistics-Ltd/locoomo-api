// Claims for lost or damaged parcels (plan §6.6, D18; MERCHANT_API.md §15).

import { ShipmentStatus } from './shipment';

const S = ShipmentStatus;

// Public contract: add, never rename.
export type ClaimType = 'lost' | 'damaged' | 'missing_item';
export const CLAIM_TYPES: readonly ClaimType[] = [
  'lost',
  'damaged',
  'missing_item',
];

// What the merchant sees. A payout waiting for a second finance admin is
// still `open` to them.
export type ClaimStatus = 'open' | 'approved' | 'rejected';

// `merchant`: filed by the merchant. `exception`: opened by Locoomo when a
// parcel was recorded lost or damaged in our care.
export type ClaimSource = 'merchant' | 'exception';

export const CLAIM_WINDOW_DAYS = 30;
export const MAX_CLAIM_EVIDENCE = 10;
// D18 default: compensation up to ₦50,000 per parcel unless the merchant's
// contract says otherwise (limits.claimCapKobo).
export const DEFAULT_CLAIM_CAP_KOBO = 5_000_000;
// Largest payout a single approval may carry (₦10m), whatever the cap.
export const MAX_CLAIM_PAYOUT_KOBO = 1_000_000_000;

export const CLAIM_PAYOUT_ACTION = 'merchant.claim_payout';

// A parcel can only be lost while it's (supposedly) with us; damage or a
// missing item can be found after it was handed over too.
const LOSABLE: readonly ShipmentStatus[] = [
  S.RECEIVED,
  S.IN_TRANSIT,
  S.READY_FOR_COLLECTION,
  S.RETURNING,
  S.RETURN_READY,
  S.EXCEPTION,
];
const NEVER_HANDLED: readonly ShipmentStatus[] = [
  S.CREATED,
  S.CANCELLED,
  S.EXPIRED,
  S.REFUSED,
  S.DISPOSED,
];

export function claimAllowed(type: ClaimType, status: ShipmentStatus): boolean {
  return type === 'lost'
    ? LOSABLE.includes(status)
    : !NEVER_HANDLED.includes(status);
}

export function claimWindowOpen(statusChangedAt: Date, now: Date): boolean {
  return (
    now.getTime() - statusChangedAt.getTime() <= CLAIM_WINDOW_DAYS * 86_400_000
  );
}

// The most a claim can pay: the declared value, capped. Without a declared
// value the cap is the ceiling and the admin assesses the loss. A null cap
// (custom contract) leaves only the declared value, or the payout ceiling.
export function maxPayoutKobo(
  declaredValueKobo: number | null,
  capKobo: number | null,
): number {
  const cap = capKobo ?? MAX_CLAIM_PAYOUT_KOBO;
  return Math.min(declaredValueKobo ?? cap, cap, MAX_CLAIM_PAYOUT_KOBO);
}

export interface ClaimPayoutPayload {
  claimId: string;
  amountKobo: number;
  merchantNote: string | null;
}

export function parseClaimPayoutPayload(
  payload: Record<string, unknown>,
): ClaimPayoutPayload | null {
  const { claimId, amountKobo, merchantNote } = payload;
  if (
    typeof claimId !== 'string' ||
    typeof amountKobo !== 'number' ||
    !Number.isSafeInteger(amountKobo) ||
    amountKobo <= 0 ||
    amountKobo > MAX_CLAIM_PAYOUT_KOBO ||
    (merchantNote !== null &&
      merchantNote !== undefined &&
      typeof merchantNote !== 'string')
  ) {
    return null;
  }
  return {
    claimId,
    amountKobo,
    merchantNote: typeof merchantNote === 'string' ? merchantNote : null,
  };
}
