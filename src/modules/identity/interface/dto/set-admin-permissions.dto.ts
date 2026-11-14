import { ArrayMaxSize, IsArray, IsEnum } from 'class-validator';
import { AdminPermission } from '../../../../common/auth/admin-permission.enum';

export class SetAdminPermissionsDto {
  // The complete new set (replaces, doesn't merge). Empty = an admin who can
  // still use every legacy admin-only screen but none of the
  // permission-gated ones.
  @IsArray()
  @ArrayMaxSize(10)
  @IsEnum(AdminPermission, { each: true })
  permissions!: AdminPermission[];
}
