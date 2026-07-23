import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../domain/user-role.enum';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
