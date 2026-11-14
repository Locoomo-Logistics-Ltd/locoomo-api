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
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import {
  AdminActor,
  AdminMerchantDetail,
  AdminMerchantsService,
  ExpiringFile,
  MerchantQueueItem,
} from '../application/admin-merchants.service';
import {
  ApproveMerchantDto,
  ListMerchantsQueryDto,
  MerchantReasonDto,
  RequestMerchantChangesDto,
  ReviewMerchantDto,
  UpdateMerchantSettingsDto,
} from './dto/admin-merchant.dto';

const actorFrom = (request: Request): AdminActor => ({
  userId: (request as RequestWithUser).user!.id,
  context: auditContextFrom(request),
});

// Admin app: merchant review queue and account controls (plan §4.3, §10).
// Not behind MerchantGuard, so the platform kill switch never locks ops out.
@Controller('admin/merchants')
export class AdminMerchantsController {
  constructor(private readonly merchants: AdminMerchantsService) {}

  @Get()
  @RequireAdminPermission(
    AdminPermission.KYC,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  async list(
    @Query() query: ListMerchantsQueryDto,
  ): Promise<PaginatedResultDto<MerchantQueueItem>> {
    const { items, total } = await this.merchants.list(query);
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }

  @Get(':id')
  @RequireAdminPermission(
    AdminPermission.KYC,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminMerchantDetail> {
    return this.merchants.detail(id);
  }

  // POST, not GET: each call is an audited disclosure, never a cacheable read.
  @Post(':id/documents/:documentId/link')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.KYC)
  documentLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() request: Request,
  ): Promise<ExpiringFile> {
    return this.merchants.documentLink(actorFrom(request), id, documentId);
  }

  @Post(':id/directors/:directorId/identity')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.KYC)
  directorIdentity(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('directorId', ParseUUIDPipe) directorId: string,
    @Req() request: Request,
  ): ReturnType<AdminMerchantsService['directorIdentity']> {
    return this.merchants.directorIdentity(actorFrom(request), id, directorId);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.KYC)
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewMerchantDto,
    @Req() request: Request,
  ): Promise<AdminMerchantDetail> {
    return this.merchants.review(actorFrom(request), id, dto.items);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.KYC)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveMerchantDto,
    @Req() request: Request,
  ): Promise<AdminMerchantDetail> {
    return this.merchants.approve(actorFrom(request), id, dto);
  }

  @Post(':id/request-changes')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.KYC)
  requestChanges(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestMerchantChangesDto,
    @Req() request: Request,
  ): Promise<AdminMerchantDetail> {
    return this.merchants.requestChanges(actorFrom(request), id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.KYC)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MerchantReasonDto,
    @Req() request: Request,
  ): Promise<AdminMerchantDetail> {
    return this.merchants.reject(actorFrom(request), id, dto.reason);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.OPS)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MerchantReasonDto,
    @Req() request: Request,
  ): Promise<AdminMerchantDetail> {
    return this.merchants.suspend(actorFrom(request), id, dto.reason);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.OPS)
  reinstate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ): Promise<AdminMerchantDetail> {
    return this.merchants.reinstate(actorFrom(request), id);
  }

  @Patch(':id/settings')
  @RequireAdminPermission(AdminPermission.OPS)
  updateSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMerchantSettingsDto,
    @Req() request: Request,
  ): Promise<AdminMerchantDetail> {
    return this.merchants.updateSettings(actorFrom(request), id, dto);
  }
}
