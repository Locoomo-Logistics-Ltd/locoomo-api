import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { RiderEarningsQueryService } from '../application/rider-earnings-query.service';
import { RiderEarningsResponseDto } from './dto/rider-earnings-response.dto';

@Controller('admin/rider-earnings')
@Roles(UserRole.ADMIN)
export class AdminRiderEarningsController {
  constructor(
    private readonly riderEarningsQueryService: RiderEarningsQueryService,
  ) {}

  @Get()
  async list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<RiderEarningsResponseDto>> {
    const result = await this.riderEarningsQueryService.list(query);
    return new PaginatedResultDto(
      result.items.map((row) => RiderEarningsResponseDto.fromRow(row)),
      result.page,
      result.limit,
      result.total,
    );
  }
}
