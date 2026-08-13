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
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { AcceptOrderService } from '../application/accept-order.service';
import { BrowseAvailableOrdersService } from '../application/browse-available-orders.service';
import { ConfirmDropOffService } from '../application/confirm-drop-off.service';
import { ConfirmHandoffService } from '../application/confirm-handoff.service';
import { OrderLookupService } from '../application/order-lookup.service';
import { RequestHandoffCodeService } from '../application/request-handoff-code.service';
import { AvailableOrderResponseDto } from './dto/available-order-response.dto';
import { AvailableOrdersQueryDto } from './dto/available-orders-query.dto';
import { ConfirmHandoffDto } from './dto/confirm-handoff.dto';
import { HandoffCodeResponseDto } from './dto/handoff-code-response.dto';
import { OrderPreviewResponseDto } from './dto/order-preview-response.dto';
import { OrderTransitionResponseDto } from './dto/order-transition-response.dto';
import { RequestHandoffCodeDto } from './dto/request-handoff-code.dto';

@Controller('handoffs')
export class HandoffsController {
  constructor(
    private readonly browseAvailableOrdersService: BrowseAvailableOrdersService,
    private readonly acceptOrderService: AcceptOrderService,
    private readonly orderLookupService: OrderLookupService,
    private readonly confirmDropOffService: ConfirmDropOffService,
    private readonly requestHandoffCodeService: RequestHandoffCodeService,
    private readonly confirmHandoffService: ConfirmHandoffService,
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

  @Roles(UserRole.RIDER)
  @Post('orders/:id/request-code')
  @HttpCode(HttpStatus.CREATED)
  async requestCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestHandoffCodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HandoffCodeResponseDto> {
    const issued = await this.requestHandoffCodeService.request(
      id,
      user.id,
      dto.type,
    );
    return HandoffCodeResponseDto.fromResult(issued);
  }

  // Rate-limited on top of the per-code failedAttempts lockout — defense in
  // depth against a wrong-code guessing spree from one IP.
  @Roles(UserRole.NODE_OPERATOR)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post('orders/:id/confirm-handoff')
  @HttpCode(HttpStatus.OK)
  async confirmHandoff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmHandoffDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderTransitionResponseDto> {
    const order = await this.confirmHandoffService.confirm(
      id,
      user.id,
      dto.type,
      dto.code,
    );
    return OrderTransitionResponseDto.fromResult(order);
  }
}
