import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import type { CursorPage } from '../../../common/pagination/cursor';
import {
  AdminClaimDetail,
  AdminClaimsService,
  AdminClaimView,
  ClaimPayoutRequested,
} from '../application/admin-claims.service';
import type { AdminActor } from '../application/admin-merchants.service';
import {
  AdminListClaimsQueryDto,
  ClaimNoteDto,
  RejectClaimDto,
  RequestClaimPayoutDto,
} from './dto/claim.dto';

const actorOf = (request: Request): AdminActor => ({
  userId: (request as RequestWithUser).user!.id,
  context: auditContextFrom(request),
});

// Admin app: merchant claims (plan §6.6). Ops, finance and support read;
// ops and finance investigate and reject; a payout is raised by `finance`
// and runs only when a second `finance` admin approves it.
@Controller('admin/merchant-claims')
export class AdminMerchantClaimsController {
  constructor(private readonly claims: AdminClaimsService) {}

  @Get()
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  list(
    @Query() query: AdminListClaimsQueryDto,
  ): Promise<CursorPage<AdminClaimView>> {
    return this.claims.list(query);
  }

  @Get(':id')
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminClaimDetail> {
    return this.claims.get(id);
  }

  @Patch(':id')
  @RequireAdminPermission(AdminPermission.FINANCE, AdminPermission.OPS)
  note(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClaimNoteDto,
    @Req() request: Request,
  ): Promise<AdminClaimDetail> {
    return this.claims.note(actorOf(request), id, dto.internalNote);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.FINANCE, AdminPermission.OPS)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectClaimDto,
    @Req() request: Request,
  ): Promise<AdminClaimDetail> {
    return this.claims.reject(actorOf(request), id, dto);
  }

  // Raises an approval request; nothing is paid until a second admin approves.
  @Post(':id/payout')
  @RequireAdminPermission(AdminPermission.FINANCE)
  requestPayout(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestClaimPayoutDto,
    @Req() request: Request,
  ): Promise<ClaimPayoutRequested> {
    return this.claims.requestPayout(actorOf(request), id, dto);
  }
}
