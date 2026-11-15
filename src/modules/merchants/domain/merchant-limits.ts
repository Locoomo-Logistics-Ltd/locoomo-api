import { MerchantTier, MerchantType } from './merchant.enums';

// Safety-net limits (plan §4.2, D12): high and permissive, editable per
// merchant by an admin. `null` = unlimited. Amounts are in kobo.
export interface MerchantLimits {
  liveShipmentsPerDay: number | null;
  maxWalletBalanceKobo: number | null;
  // How far a wallet may go below zero after re-pricing (plan §8.4). A
  // negative number, or null for a custom (unlimited) floor.
  negativeBalanceFloorKobo: number | null;
  // Most a claim pays per parcel (plan D18, F5). null = only the declared
  // value limits it (a custom contract).
  claimCapKobo: number | null;
}

const NAIRA = 100;

export const TIER_DEFAULT_LIMITS: Readonly<
  Record<MerchantTier, MerchantLimits>
> = {
  [MerchantTier.INDIVIDUAL]: {
    liveShipmentsPerDay: 2_000,
    maxWalletBalanceKobo: 50_000_000 * NAIRA,
    negativeBalanceFloorKobo: -50_000 * NAIRA,
    claimCapKobo: 50_000 * NAIRA,
  },
  [MerchantTier.BUSINESS]: {
    liveShipmentsPerDay: 100_000,
    maxWalletBalanceKobo: 2_000_000_000 * NAIRA,
    negativeBalanceFloorKobo: -1_000_000 * NAIRA,
    claimCapKobo: 50_000 * NAIRA,
  },
  [MerchantTier.ENTERPRISE]: {
    liveShipmentsPerDay: null,
    maxWalletBalanceKobo: null,
    negativeBalanceFloorKobo: null,
    claimCapKobo: 50_000 * NAIRA,
  },
};

export function defaultTierFor(type: MerchantType): MerchantTier {
  return type === MerchantType.BUSINESS
    ? MerchantTier.BUSINESS
    : MerchantTier.INDIVIDUAL;
}

// Tier defaults with the admin's per-merchant overrides on top. An
// override of `null` means "unlimited"; an absent key keeps the default.
export function resolveLimits(
  tier: MerchantTier,
  overrides: Partial<MerchantLimits> | null | undefined,
): MerchantLimits {
  return { ...TIER_DEFAULT_LIMITS[tier], ...(overrides ?? {}) };
}
