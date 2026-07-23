import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../domain/user-role.enum';
import { InsufficientRoleException } from '../domain/exceptions/insufficient-role.exception';
import { UnauthenticatedException } from '../domain/exceptions/unauthenticated.exception';
import { RequestWithUser } from './auth.guard';
import { ROLES_KEY } from './decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      throw new UnauthenticatedException();
    }

    if (!requiredRoles.includes(request.user.role)) {
      throw new InsufficientRoleException();
    }

    return true;
  }
}
