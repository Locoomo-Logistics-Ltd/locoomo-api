// Fine-grained powers within the single `admin` role (plan E12). An admin
// can hold several. `super` implies every other permission.
//
// Existing @Roles(UserRole.ADMIN) routes are unchanged (any admin); new
// sensitive routes add @RequireAdminPermission(...) on top.
export enum AdminPermission {
  SUPER = 'super',
  // Merchant KYC review: view documents, approve/reject/request changes.
  KYC = 'kyc',
  // Wallets, manual adjustments, claims payouts, refunds, pricing.
  FINANCE = 'finance',
  // Day-to-day operations: reroutes, suspensions, hubs, exceptions.
  OPS = 'ops',
  // Read-mostly support tooling, MFA resets.
  SUPPORT = 'support',
}

export const ALL_ADMIN_PERMISSIONS = Object.values(AdminPermission);

export function hasAdminPermission(
  held: readonly string[],
  required: AdminPermission,
): boolean {
  return held.includes(AdminPermission.SUPER) || held.includes(required);
}
