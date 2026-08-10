import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../../common/auth/user-role.enum';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { AdminPricingService } from '../application/admin-pricing.service';
import { CreatePricingRuleDto } from './dto/create-pricing-rule.dto';
import { PricingRuleResponseDto } from './dto/pricing-rule-response.dto';

@Controller('admin/pricing')
@Roles(UserRole.ADMIN)
export class PricingController {
  constructor(private readonly adminPricingService: AdminPricingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreatePricingRuleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PricingRuleResponseDto> {
    const rule = await this.adminPricingService.create(dto, user.id);
    return PricingRuleResponseDto.fromEntity(rule);
  }

  @Get()
  async list(
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<PricingRuleResponseDto>> {
    const result = await this.adminPricingService.list(query);
    return new PaginatedResultDto(
      result.items.map((rule) => PricingRuleResponseDto.fromEntity(rule)),
      result.page,
      result.limit,
      result.total,
    );
  }
}
