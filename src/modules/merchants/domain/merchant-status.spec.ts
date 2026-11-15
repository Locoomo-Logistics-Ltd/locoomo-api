import { MerchantStatus as S } from './merchant.enums';
import {
  ROLE_PERMISSIONS,
  MerchantPermission as P,
} from './merchant-permissions';
import { canTransition } from './merchant-status';
import { resolveLimits } from './merchant-limits';
import { MerchantRole, MerchantTier } from './merchant.enums';

describe('merchant status machine', () => {
  it.each([
    [S.DRAFT, S.SUBMITTED],
    [S.SUBMITTED, S.IN_REVIEW],
    [S.IN_REVIEW, S.CHANGES_REQUESTED],
    [S.CHANGES_REQUESTED, S.SUBMITTED],
    [S.IN_REVIEW, S.APPROVED],
    [S.APPROVED, S.SUSPENDED],
    [S.SUSPENDED, S.APPROVED],
    [S.REJECTED, S.CLOSED],
  ])('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    [S.DRAFT, S.APPROVED],
    [S.APPROVED, S.SUBMITTED],
    [S.REJECTED, S.SUBMITTED],
    [S.SUSPENDED, S.CLOSED],
    [S.CLOSED, S.DRAFT],
  ])('refuses %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe('team permissions', () => {
  it('reserves ownership actions for the owner', () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes(P.OWNERSHIP))
      .map(([role]) => role);
    expect(holders).toEqual([MerchantRole.OWNER]);
  });

  it('gives finance the wallet but not shipment writes', () => {
    expect(ROLE_PERMISSIONS[MerchantRole.FINANCE]).toEqual([
      P.SHIPMENTS_READ,
      P.WALLET_MANAGE,
    ]);
  });
});

describe('limits', () => {
  it('layers per-merchant overrides on the tier defaults; null means unlimited', () => {
    expect(
      resolveLimits(MerchantTier.BUSINESS, { liveShipmentsPerDay: null }),
    ).toEqual({
      liveShipmentsPerDay: null,
      maxWalletBalanceKobo: 200_000_000_000,
      negativeBalanceFloorKobo: -100_000_000,
      claimCapKobo: 5_000_000,
    });
  });
});
