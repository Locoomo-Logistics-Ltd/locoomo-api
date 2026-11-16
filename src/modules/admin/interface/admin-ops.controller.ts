import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
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

// Admin app (plan §10, M6b): All orders, and Platform health.
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
}
