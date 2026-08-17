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
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { AcceptOrderService } from '../application/accept-order.service';
import { BrowseAvailableOrdersService } from '../application/browse-available-orders.service';
import { ConfirmCollectionService } from '../application/confirm-collection.service';
import { ConfirmDropOffService } from '../application/confirm-drop-off.service';
import { ConfirmHandoffService } from '../application/confirm-handoff.service';
import { ConfirmIntakeService } from '../application/confirm-intake.service';
import { ListMyNodeOrdersService } from '../application/list-my-node-orders.service';
import { ListMyOrdersService } from '../application/list-my-orders.service';
import { OrderLookupService } from '../application/order-lookup.service';
import { RequestHandoffCodeService } from '../application/request-handoff-code.service';
import { ResendCollectionCodeService } from '../application/resend-collection-code.service';
import { AvailableOrderResponseDto } from './dto/available-order-response.dto';
import { AvailableOrdersQueryDto } from './dto/available-orders-query.dto';
import { CollectionCodeResendResponseDto } from './dto/collection-code-resend-response.dto';
import { ConfirmCollectionDto } from './dto/confirm-collection.dto';
import { ConfirmHandoffDto } from './dto/confirm-handoff.dto';
import { HandoffCodeResponseDto } from './dto/handoff-code-response.dto';
import { MyNodeOrderResponseDto } from './dto/my-node-order-response.dto';
import { MyOrderResponseDto } from './dto/my-order-response.dto';
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
    private readonly confirmIntakeService: ConfirmIntakeService,
    private readonly resendCollectionCodeService: ResendCollectionCodeService,
    private readonly confirmCollectionService: ConfirmCollectionService,
    private readonly listMyOrdersService: ListMyOrdersService,
    private readonly listMyNodeOrdersService: ListMyNodeOrdersService,
  ) {}

  @Roles(UserRole.RIDER)
  @Get('available-orders')
  browse(
    @Query() query: AvailableOrdersQueryDto,
  ): Promise<PaginatedResultDto<AvailableOrderResponseDto>> {
    return this.browseAvailableOrdersService.browse(query);
  }

  // The counterpart to browse()/accept() — every order this rider has ever
  // been assigned, current and past, so they have both a work queue (filter
  // client-side on status: rider_assigned/in_transit) and a personal record.
  @Roles(UserRole.RIDER)
  @Get('my-orders')
  myOrders(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<MyOrderResponseDto>> {
    return this.listMyOrdersService.list(user.id, query);
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

  // Node-operator counterpart to my-orders — every order that's ever
  // touched this operator's Node, either as origin or destination, current
  // and past. myRole on each item disambiguates which side of that order
  // their Node played.
  @Roles(UserRole.NODE_OPERATOR)
  @Get('my-node/orders')
  myNodeOrders(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<MyNodeOrderResponseDto>> {
    return this.listMyNodeOrdersService.list(user.id, query);
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

  // Destination-side equivalent of drop-off — mints and emails the
  // receiver's collection code as part of the same transition.
  @Roles(UserRole.NODE_OPERATOR)
  @Post('orders/:id/intake')
  @HttpCode(HttpStatus.OK)
  async intake(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderTransitionResponseDto> {
    const order = await this.confirmIntakeService.confirm(id, user.id);
    return OrderTransitionResponseDto.fromResult(order);
  }

  // Rate-limited — this triggers a real email send, not just a lockout
  // counter concern.
  @Roles(UserRole.NODE_OPERATOR)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('orders/:id/collection-code/resend')
  @HttpCode(HttpStatus.OK)
  async resendCollectionCode(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CollectionCodeResendResponseDto> {
    const issued = await this.resendCollectionCodeService.resend(id, user.id);
    return CollectionCodeResendResponseDto.fromResult(issued);
  }

  @Roles(UserRole.NODE_OPERATOR)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post('orders/:id/collect')
  @HttpCode(HttpStatus.OK)
  async collect(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmCollectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderTransitionResponseDto> {
    const order = await this.confirmCollectionService.confirm(
      id,
      user.id,
      dto.code,
      dto.identityConfirmed,
    );
    return OrderTransitionResponseDto.fromResult(order);
  }
}
