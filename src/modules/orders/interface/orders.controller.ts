import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { DeliveryQueryService } from '../../logistics/application/delivery-query.service';
import { TrackingLinkService } from '../../tracking/application/tracking-link.service';
import { OrderQueryService } from '../application/order-query.service';
import { OrderTimelineService } from '../../tracking/application/order-timeline.service';
import type { TimelineItem } from '../../tracking/application/order-timeline.service';
import { MyOrdersQueryDto } from './dto/my-orders-query.dto';
import { OrderResponseDto } from './dto/order-response.dto';

@Controller('orders')
@Roles(UserRole.CONSUMER)
export class OrdersController {
  constructor(
    private readonly orderQueryService: OrderQueryService,
    private readonly trackingLinkService: TrackingLinkService,
    private readonly deliveryQueryService: DeliveryQueryService,
    private readonly orderTimelineService: OrderTimelineService,
  ) {}

  @Get()
  async findMine(
    @Query() query: MyOrdersQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<OrderResponseDto>> {
    const result = await this.orderQueryService.findMine(user.id, query);
    const deliveries = await this.deliveryQueryService.viewsFor(
      result.items.map((order) => order.id),
      'consumer',
    );
    return new PaginatedResultDto(
      result.items.map((order) =>
        OrderResponseDto.fromRow(
          order,
          this.trackingLinkService.urlFor(order.trackingCode),
          deliveries.get(order.id) ?? null,
        ),
      ),
      result.page,
      result.limit,
      result.total,
    );
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderResponseDto> {
    const row = await this.orderQueryService.getMine(user.id, id);
    return OrderResponseDto.fromRow(
      row,
      this.trackingLinkService.urlFor(row.trackingCode),
      await this.deliveryQueryService.viewFor(row.id, 'consumer'),
    );
  }

  // The order's history in plain words, oldest first — the same steps the
  // public tracking page shows (drop-off, courier, arrival, collection, and
  // a return if there was one).
  @Get(':id/timeline')
  async timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TimelineItem[]> {
    await this.orderQueryService.getMine(user.id, id);
    return this.orderTimelineService.timelineFor(id);
  }
}
