import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { AdminRevenueSplitRuleService } from '../application/admin-revenue-split-rule.service';
import { MarkRevenueSplitPaidService } from '../application/mark-revenue-split-paid.service';
import { RevenueSplitQueryService } from '../application/revenue-split-query.service';
import { AdminRevenueSplitEntryResponseDto } from './dto/admin-revenue-split-entry-response.dto';
import { CreateRevenueSplitRuleDto } from './dto/create-revenue-split-rule.dto';
import { ListRevenueSplitEntriesQueryDto } from './dto/list-revenue-split-entries-query.dto';
import { MarkRevenueSplitPaidResponseDto } from './dto/mark-revenue-split-paid-response.dto';
import { RevenueSplitRuleResponseDto } from './dto/revenue-split-rule-response.dto';

@Controller('admin/revenue-split')
@Roles(UserRole.ADMIN)
export class AdminRevenueSplitController {
  constructor(
    private readonly adminRevenueSplitRuleService: AdminRevenueSplitRuleService,
    private readonly revenueSplitQueryService: RevenueSplitQueryService,
    private readonly markRevenueSplitPaidService: MarkRevenueSplitPaidService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createRule(
    @Body() dto: CreateRevenueSplitRuleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RevenueSplitRuleResponseDto> {
    const rule = await this.adminRevenueSplitRuleService.create(dto, user.id);
    return RevenueSplitRuleResponseDto.fromRow(rule);
  }

  @Get()
  async listRules(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<RevenueSplitRuleResponseDto>> {
    const result = await this.adminRevenueSplitRuleService.list(query);
    return new PaginatedResultDto(
      result.items.map((rule) => RevenueSplitRuleResponseDto.fromRow(rule)),
      result.page,
      result.limit,
      result.total,
    );
  }

  @Get('entries')
  async listEntries(
    @Query() query: ListRevenueSplitEntriesQueryDto,
  ): Promise<PaginatedResultDto<AdminRevenueSplitEntryResponseDto>> {
    const result = await this.revenueSplitQueryService.listAll(query);
    return new PaginatedResultDto(
      result.items.map((row) => AdminRevenueSplitEntryResponseDto.fromRow(row)),
      result.page,
      result.limit,
      result.total,
    );
  }

  @Patch('entries/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  async markPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MarkRevenueSplitPaidResponseDto> {
    const result = await this.markRevenueSplitPaidService.markPaid(id, user.id);
    return MarkRevenueSplitPaidResponseDto.fromResult(result);
  }
}
