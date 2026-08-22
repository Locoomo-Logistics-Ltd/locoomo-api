import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { nairaToKobo } from '../domain/money';
import { PricingRuleEntity } from '../infrastructure/entities/pricing-rule.entity';
import { CreatePricingRuleDto } from '../interface/dto/create-pricing-rule.dto';

@Injectable()
export class AdminPricingService {
  constructor(
    @InjectRepository(PricingRuleEntity)
    private readonly pricingRules: Repository<PricingRuleEntity>,
  ) {}

  // Effective immediately (server-set, never client-settable) — a new rule
  // is a new append-only row, never an UPDATE of an existing one (see
  // PricingRuleEntity). Future-dated scheduling isn't built: nothing needs
  // it yet, and the schema doesn't block adding it later.
  async create(
    dto: CreatePricingRuleDto,
    adminId: string,
  ): Promise<PricingRuleEntity> {
    return this.pricingRules.save(
      this.pricingRules.create({
        baseFeeKobo: nairaToKobo(dto.baseFeeNaira),
        perKmRateKobo: nairaToKobo(dto.perKmRateNaira),
        destinationFeeKobo: nairaToKobo(dto.destinationFeeNaira),
        createdByAdminId: adminId,
      }),
    );
  }

  async list(
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<PricingRuleEntity>> {
    const [items, total] = await this.pricingRules.findAndCount({
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      order: { effectiveFrom: 'DESC' },
    });

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
