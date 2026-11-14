import { MerchantRole } from './merchant.enums';

// What a team member may do (plan §3.3). Enforced server-side by
// MerchantGuard; the dashboard gets the caller's list from
// GET /merchant/account (`me.permissions`) only to hide buttons.
export enum MerchantPermission {
  SHIPMENTS_READ = 'shipments.read',
  SHIPMENTS_WRITE = 'shipments.write',
  RETURNS_COLLECT = 'returns.collect',
  DEVELOPERS_MANAGE = 'developers.manage',
  WALLET_MANAGE = 'wallet.manage',
  ACCOUNT_MANAGE = 'account.manage',
  TEAM_MANAGE = 'team.manage',
  OWNERSHIP = 'ownership',
}

const P = MerchantPermission;

export const ROLE_PERMISSIONS: Readonly<
  Record<MerchantRole, readonly MerchantPermission[]>
> = {
  [MerchantRole.OWNER]: Object.values(P),
  [MerchantRole.ADMIN]: Object.values(P).filter((p) => p !== P.OWNERSHIP),
  [MerchantRole.DEVELOPER]: [
    P.SHIPMENTS_READ,
    P.SHIPMENTS_WRITE,
    P.DEVELOPERS_MANAGE,
  ],
  [MerchantRole.OPERATIONS]: [
    P.SHIPMENTS_READ,
    P.SHIPMENTS_WRITE,
    P.RETURNS_COLLECT,
  ],
  [MerchantRole.FINANCE]: [P.SHIPMENTS_READ, P.WALLET_MANAGE],
  [MerchantRole.VIEWER]: [P.SHIPMENTS_READ],
};

export function roleHasPermission(
  role: MerchantRole,
  permission: MerchantPermission,
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// Roles a member can be invited as or changed to. Ownership only moves
// through an explicit transfer.
export const ASSIGNABLE_ROLES: readonly MerchantRole[] = [
  MerchantRole.ADMIN,
  MerchantRole.DEVELOPER,
  MerchantRole.OPERATIONS,
  MerchantRole.FINANCE,
  MerchantRole.VIEWER,
];
