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
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { Request } from 'express';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import type { RequestWithUser } from '../../../common/auth/auth.guard';
import { RequireAdminPermission } from '../../../common/auth/decorators/require-admin-permission.decorator';
import { auditContextFrom } from '../../../common/audit/audit.service';
import {
  RerouteQueueItem,
  RerouteService,
} from '../application/reroute.service';

export class RerouteQueueQueryDto {
  /** `pending` (default): waiting for a decision. `auto`: picked by the system in the last 7 days, to review. */
  @IsOptional()
  @IsIn(['pending', 'auto'])
  state: 'pending' | 'auto' = 'pending';
}

export class ResolveRerouteDto {
  @IsUUID()
  destinationNodeId!: string;

  /** Internal note (audited). */
  @IsString()
  @Length(3, 500)
  reason!: string;
}

// Admin app › Reroutes (plan §6.5): merchant parcels whose destination was
// full or closed at drop-off, waiting at their origin for a new one.
@Controller('admin/reroutes')
export class AdminReroutesController {
  constructor(private readonly reroutes: RerouteService) {}

  @Get()
  @RequireAdminPermission(AdminPermission.OPS, AdminPermission.SUPPORT)
  queue(@Query() query: RerouteQueueQueryDto): Promise<RerouteQueueItem[]> {
    return this.reroutes.queue(query.state);
  }

  @Post(':orderId')
  @HttpCode(HttpStatus.OK)
  @RequireAdminPermission(AdminPermission.OPS)
  resolve(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: ResolveRerouteDto,
    @Req() request: Request,
  ): Promise<{ orderId: string; destinationNodeId: string }> {
    return this.reroutes.resolve(
      (request as RequestWithUser).user!.id,
      orderId,
      dto,
      auditContextFrom(request),
    );
  }
}
