import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { AcceptOrderService } from '../application/accept-order.service';
import { BrowseAvailableOrdersService } from '../application/browse-available-orders.service';
import { ConfirmDropOffService } from '../application/confirm-drop-off.service';
import { OrderLookupService } from '../application/order-lookup.service';
import { AvailableOrderResponseDto } from './dto/available-order-response.dto';
import { AvailableOrdersQueryDto } from './dto/available-orders-query.dto';
import { OrderPreviewResponseDto } from './dto/order-preview-response.dto';
import { OrderTransitionResponseDto } from './dto/order-transition-response.dto';

@Controller('handoffs')
export class HandoffsController {
  constructor(
    private readonly browseAvailableOrdersService: BrowseAvailableOrdersService,
    private readonly acceptOrderService: AcceptOrderService,
    private readonly orderLookupService: OrderLookupService,
    private readonly confirmDropOffService: ConfirmDropOffService,
  ) {}

  @Roles(UserRole.RIDER)
  @Get('available-orders')
  browse(
    @Query() query: AvailableOrdersQueryDto,
  ): Promise<PaginatedResultDto<AvailableOrderResponseDto>> {
    return this.browseAvailableOrdersService.browse(query);
  }

  @Roles(UserRole.RIDER)
  @Post('orders/:id/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderTransitionResponseDto> {
    const order = await this.acceptOrderService.accept(id, user.id);
    return OrderTransitionResponseDto.fromResult(order);
  }

  @Roles(UserRole.NODE_OPERATOR)
  @Get('orders/by-tracking-code/:code')
  async findByTrackingCode(
    @Param('code') code: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderPreviewResponseDto> {
    const row = await this.orderLookupService.findByTrackingCodeForOrigin(
      code,
      user.id,
    );
    return OrderPreviewResponseDto.fromRow(row);
  }

  @Roles(UserRole.NODE_OPERATOR)
  @Post('orders/:id/drop-off')
  @HttpCode(HttpStatus.OK)
  async dropOff(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderTransitionResponseDto> {
    const order = await this.confirmDropOffService.confirm(id, user.id);
    return OrderTransitionResponseDto.fromResult(order);
  }
}
