import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { IsEnum, IsOptional } from 'class-validator';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import type { CourierHandoverInfo } from '../../logistics/application/courier-handover.service';
import { BagDetailView, BagService, BagView } from '../application/bag.service';
import { BagStatus } from '../domain/bag';

export class ListBagsQueryDto {
  @IsOptional()
  @IsEnum(BagStatus)
  status?: BagStatus;
}

// Node app (LOGISTICS_API.md §5.12): bags packed at a hub and unpacked at
// the destination. Parcels go into bags by themselves at hub drop-off.
@Controller('handoffs/bags')
export class BagsController {
  constructor(private readonly bags: BagService) {}

  /** Bags at your Nodes, leaving or arriving (not finished ones). */
  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Get()
  list(
    @Query() query: ListBagsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BagView[]> {
    return this.bags.listForNode(user.id, query.status);
  }

  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Get(':code')
  get(
    @Param('code') code: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BagDetailView> {
    return this.bags.detail(user.id, code);
  }

  /** Close it and book its courier (it seals itself at 50 parcels). */
  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Post(':code/seal')
  @HttpCode(HttpStatus.OK)
  seal(
    @Param('code') code: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BagDetailView> {
    return this.bags.sealByStaff(user.id, code);
  }

  /** The courier's code for this bag: pickup at the hub, delivery at the destination. */
  @Roles(UserRole.NODE_OPERATOR, UserRole.NODE_STAFF)
  @Get(':code/courier-handover')
  courierHandover(
    @Param('code') code: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<(CourierHandoverInfo & { kind: 'pickup' | 'delivery' }) | null> {
    return this.bags.courierHandover(user.id, code);
  }
}
