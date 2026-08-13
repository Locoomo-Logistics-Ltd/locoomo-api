import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { OrderQueryService } from '../application/order-query.service';
import { OrderResponseDto } from './dto/order-response.dto';

@Controller('orders')
@Roles(UserRole.CONSUMER)
export class OrdersController {
  constructor(private readonly orderQueryService: OrderQueryService) {}

  @Get()
  async findMine(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<OrderResponseDto>> {
    const result = await this.orderQueryService.findMine(user.id, query);
    return new PaginatedResultDto(
      result.items.map((order) => OrderResponseDto.fromRow(order)),
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
    return OrderResponseDto.fromRow(row);
  }
}
