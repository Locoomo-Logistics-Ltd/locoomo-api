import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import {
  auditActorFrom,
  auditContextFrom,
} from '../../../common/audit/audit.service';
import {
  AdminPermissionService,
  AdminSummary,
} from '../application/admin-permission.service';
import { SetAdminPermissionsDto } from './dto/set-admin-permissions.dto';

@Controller('admin/admins')
@RequireAdminPermission(AdminPermission.SUPER)
export class AdminAdminsController {
  constructor(private readonly permissions: AdminPermissionService) {}

  @Get()
  list(): Promise<AdminSummary[]> {
    return this.permissions.list();
  }

  @Patch(':id/permissions')
  setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetAdminPermissionsDto,
    @Req() request: Request,
  ): Promise<AdminSummary> {
    return this.permissions.setPermissions(
      id,
      dto.permissions,
      auditActorFrom(request),
      auditContextFrom(request),
    );
  }
}
