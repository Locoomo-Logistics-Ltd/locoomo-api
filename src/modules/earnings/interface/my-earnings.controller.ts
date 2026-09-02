import { Controller, Get, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import { RevenueSplitQueryService } from '../application/revenue-split-query.service';
import { RevenueSplitEntryResponseDto } from './dto/revenue-split-entry-response.dto';

@Controller('earnings')
export class MyEarningsController {
  constructor(
    private readonly revenueSplitQueryService: RevenueSplitQueryService,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  @Roles(UserRole.RIDER)
  @Get('mine')
  async mine(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<RevenueSplitEntryResponseDto>> {
    const result = await this.revenueSplitQueryService.listForRider(
      user.id,
      query,
    );
    return new PaginatedResultDto(
      result.items.map((row) => RevenueSplitEntryResponseDto.fromRow(row)),
      result.page,
      result.limit,
      result.total,
    );
  }

  @Roles(UserRole.NODE_OPERATOR)
  @Get('my-node')
  async myNode(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedResultDto<RevenueSplitEntryResponseDto>> {
    const nodeIds = await this.nodeOperatorQueryService.getNodeIdsForUser(
      user.id,
    );
    const result = await this.revenueSplitQueryService.listForNode(
      nodeIds,
      query,
    );
    return new PaginatedResultDto(
      result.items.map((row) => RevenueSplitEntryResponseDto.fromRow(row)),
      result.page,
      result.limit,
      result.total,
    );
  }
}
