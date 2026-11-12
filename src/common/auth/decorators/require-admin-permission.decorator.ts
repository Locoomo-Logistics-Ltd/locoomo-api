import { SetMetadata } from '@nestjs/common';
import { AdminPermission } from '../admin-permission.enum';

export const ADMIN_PERMISSIONS_KEY = 'adminPermissions';

// Admin-only route that additionally needs ANY ONE of these permissions
// (`super` always qualifies). Implies the admin role — no separate
// @Roles(UserRole.ADMIN) needed. Enforced by identity's AdminPermissionGuard.
export const RequireAdminPermission = (
  ...anyOf: AdminPermission[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_PERMISSIONS_KEY, anyOf);
