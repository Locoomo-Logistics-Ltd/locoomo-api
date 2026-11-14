import type { ApiKeyMode } from './api-key';

// Merchant wallet (plan §8, E2): prepaid, per merchant and mode. A shipment
// places a hold for its quoted fee; the hold is captured when the parcel is
// received (at the final price) or released if it never is. Money only
// moves through append-only entries; the wallet row caches the totals.

// Test wallets start with ₦1,000,000 and can be reset to it.
export const TEST_WALLET_FUNDING_KOBO = 100_000_000;

// Ceiling for one admin adjustment (₦1bn): a typo guard, not a policy.
export const MAX_ADJUSTMENT_KOBO = 100_000_000_000;

export const WALLET_ADJUSTMENT_ACTION = 'merchant.wallet_adjustment';

// Public contract (MERCHANT_API.md §14): add, never rename.
export enum WalletEntryType {
  // Test wallets: the starting ₦1,000,000 and resets back to it.
  TEST_FUNDING = 'test_funding',
  TOP_UP = 'top_up',
  // A shipment's fee, captured when the parcel was received.
  SHIPMENT_CHARGE = 'shipment_charge',
  // Re-priced after we measured the parcel (D14). Negative = charged more.
  SHIPMENT_ADJUSTMENT = 'shipment_adjustment',
  // A Locoomo admin's correction, approved by a second admin (E12).
  ADJUSTMENT = 'adjustment',
  CLAIM_CREDIT = 'claim_credit',
  REFUND = 'refund',
}

export type HoldStatus = 'active' | 'captured' | 'released';

export type TopUpMethod = 'card' | 'bank_transfer';
// abandoned: a card payment never completed within a day. A late success
// still credits it.
export type TopUpStatus = 'pending' | 'succeeded' | 'failed' | 'abandoned';

// Card top-up bounds: ₦1,000 to ₦10,000,000 per payment.
export const MIN_CARD_TOP_UP_KOBO = 100_000;
export const MAX_CARD_TOP_UP_KOBO = 1_000_000_000;

// Ledger idempotency key for a Paystack charge.
export const paystackExternalRef = (reference: string): string =>
  `paystack:${reference}`;

// Our reference for a card top-up (Paystack accepts caller references).
export const cardTopUpReference = (topUpId: string): string =>
  `wallet-${topUpId}`;

// What reaches the wallet: card fees are passed through (F2), transfer
// fees are absorbed by Locoomo.
export function creditedAmount(
  method: TopUpMethod,
  amountKobo: number,
  feeKobo: number,
): number {
  return method === 'card' ? Math.max(amountKobo - feeKobo, 0) : amountKobo;
}

// Live wallets can't be topped up past the merchant's ceiling (D12; null =
// unlimited). Transfers that already happened are always credited.
export function exceedsWalletCeiling(
  balanceKobo: number,
  topUpKobo: number,
  maxWalletBalanceKobo: number | null | undefined,
): boolean {
  return (
    maxWalletBalanceKobo !== null &&
    maxWalletBalanceKobo !== undefined &&
    balanceKobo + topUpKobo > maxWalletBalanceKobo
  );
}

export interface WalletTotals {
  balanceKobo: number;
  heldKobo: number;
}

export function availableKobo(wallet: WalletTotals): number {
  return wallet.balanceKobo - wallet.heldKobo;
}

// ₦25,000.00 / −₦1,250.50
export function formatNaira(kobo: number): string {
  const sign = kobo < 0 ? '−' : '';
  const naira = Math.abs(kobo) / 100;
  return `${sign}₦${naira.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface WalletAdjustmentPayload {
  merchantId: string;
  mode: ApiKeyMode;
  amountKobo: number;
}

// Validates an approval payload (it's stored as JSON, so re-check types).
export function parseAdjustmentPayload(
  payload: Record<string, unknown>,
): WalletAdjustmentPayload | null {
  const { merchantId, mode, amountKobo } = payload;
  if (
    typeof merchantId !== 'string' ||
    (mode !== 'test' && mode !== 'live') ||
    typeof amountKobo !== 'number' ||
    !Number.isSafeInteger(amountKobo) ||
    amountKobo === 0 ||
    Math.abs(amountKobo) > MAX_ADJUSTMENT_KOBO
  ) {
    return null;
  }
  return { merchantId, mode, amountKobo };
}
