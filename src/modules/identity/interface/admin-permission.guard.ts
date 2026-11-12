import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { ADMIN_PERMISSIONS_KEY } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import {
  InsufficientRoleException,
  UnauthenticatedException,
} from '../../../common/exceptions';
import { AdminPermissionService } from '../application/admin-permission.service';

// Global (APP_GUARD, after AuthGuard/RolesGuard). Only acts on routes marked
// @RequireAdminPermission. The JWT carries the role but not permissions —
// those are looked up (cached ~30s) so a revocation bites quickly without
// waiting for the 15-minute access token to expire.
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: AdminPermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const anyOf = this.reflector.getAllAndOverride<
      AdminPermission[] | undefined
    >(ADMIN_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!anyOf) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      throw new UnauthenticatedException();
    }
    if (request.user.role !== UserRole.ADMIN) {
      throw new InsufficientRoleException();
    }
    if (!(await this.permissions.hasAny(request.user.id, anyOf))) {
      throw new InsufficientRoleException();
    }
    return true;
  }
}
