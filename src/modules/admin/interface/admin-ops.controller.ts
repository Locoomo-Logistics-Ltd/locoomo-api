import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { Public } from '../../../common/auth/decorators/public.decorator';
import { SkipResponseEnvelope } from '../../../common/decorators/skip-response-envelope.decorator';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import type { CursorPage } from '../../../common/pagination/cursor';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import {
  AdminOrderDetail,
  AdminOrderRow,
  AdminOrdersQueryService,
} from '../application/admin-orders-query.service';
import {
  PlatformHealth,
  PlatformHealthService,
} from '../application/platform-health.service';

export class AdminOrdersQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(['consumer', 'merchant'])
  source?: 'consumer' | 'merchant';

  @IsOptional()
  @IsUUID()
  merchantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  /** Origin or destination. */
  @IsOptional()
  @IsUUID()
  nodeId?: string;

  /** Forgiving, like the Node app's scan. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  trackingCode?: string;

  /** A merchant's own reference. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsIn(['pending', 'resolved'])
  rerouteState?: 'pending' | 'resolved';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AdminOrdersExportDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsOptional()
  @IsIn(['consumer', 'merchant'])
  source?: 'consumer' | 'merchant';

  @IsOptional()
  @IsUUID()
  merchantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @IsOptional()
  @IsUUID()
  nodeId?: string;
}

// Admin app (plan §10, M6b/M6c): All orders (and its CSV export), Platform
// health.
@Controller('admin')
export class AdminOpsController {
  constructor(
    private readonly orders: AdminOrdersQueryService,
    private readonly health: PlatformHealthService,
  ) {}

  @Get('orders')
  @RequireAdminPermission(AdminPermission.OPS, AdminPermission.SUPPORT)
  list(
    @Query() query: AdminOrdersQueryDto,
  ): Promise<CursorPage<AdminOrderRow>> {
    return this.orders.list(query);
  }

  @Get('orders/:id')
  @RequireAdminPermission(AdminPermission.OPS, AdminPermission.SUPPORT)
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<AdminOrderDetail> {
    return this.orders.detail(id);
  }

  @Get('merchant-platform/health')
  @RequireAdminPermission(AdminPermission.OPS, AdminPermission.SUPPORT)
  platformHealth(): Promise<PlatformHealth> {
    return this.health.health();
  }

  // The All orders list as CSV: a 15-minute download link.
  @Post('exports/orders')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.OPS)
  exportOrders(
    @Body() dto: AdminOrdersExportDto,
    @Req() request: Request,
  ): Promise<{ downloadPath: string; expiresAt: string }> {
    return this.orders.createExport((request as RequestWithUser).user!.id, dto);
  }
}

// The signed link itself: the token is the credential.
@Controller('admin/exports')
export class AdminExportDownloadController {
  constructor(private readonly orders: AdminOrdersQueryService) {}

  @Public()
  @Get('orders/download')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @SkipResponseEnvelope()
  async download(
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.orders.streamExport(token ?? '', res);
  }
}
