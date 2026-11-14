import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
  AdminWalletService,
  WalletAdjustmentRequested,
} from '../application/admin-wallet.service';
import type {
  WalletEntryView,
  WalletHoldView,
  WalletView,
} from '../application/wallet.service';
import {
  AdminListWalletEntriesQueryDto,
  AdminListWalletHoldsQueryDto,
  AdminWalletModeQueryDto,
  RequestWalletAdjustmentDto,
} from './dto/wallet.dto';

// Admin app: a merchant's wallet (plan §8.6). Reading is for finance, ops
// and support; adjustments are raised by `finance` and run only after a
// second `finance` admin approves them in /admin/approvals.
@Controller('admin/merchants/:id/wallet')
export class AdminMerchantWalletController {
  constructor(private readonly wallets: AdminWalletService) {}

  @Get()
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  summary(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminWalletModeQueryDto,
  ): Promise<WalletView> {
    return this.wallets.summary(id, query.mode);
  }

  @Get('entries')
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  entries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminListWalletEntriesQueryDto,
  ): Promise<CursorPage<WalletEntryView>> {
    return this.wallets.entries(id, query.mode, query);
  }

  @Get('holds')
  @RequireAdminPermission(
    AdminPermission.FINANCE,
    AdminPermission.OPS,
    AdminPermission.SUPPORT,
  )
  holds(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminListWalletHoldsQueryDto,
  ): Promise<CursorPage<WalletHoldView>> {
    return this.wallets.holds(
      id,
      query.mode,
      query.status,
      query.limit,
      query.cursor,
    );
  }

  // Raises an approval request; nothing moves until a second admin approves.
  @Post('adjustments')
  @RequireAdminPermission(AdminPermission.FINANCE)
  requestAdjustment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestWalletAdjustmentDto,
    @Req() request: Request,
  ): Promise<WalletAdjustmentRequested> {
    return this.wallets.requestAdjustment(
      {
        userId: (request as RequestWithUser).user!.id,
        context: auditContextFrom(request),
      },
      id,
      dto,
    );
  }
}
