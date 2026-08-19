import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { InvalidRevenueSplitException } from '../domain/exceptions/invalid-revenue-split.exception';
import { RevenueSplitRuleEntity } from '../infrastructure/entities/revenue-split-rule.entity';
import { CreateRevenueSplitRuleDto } from '../interface/dto/create-revenue-split-rule.dto';
import { RevenueSplitRuleRow } from '../interface/dto/revenue-split-rule-response.dto';

// Mirrors AdminPricingService — append-only (see RevenueSplitRuleEntity),
// effective immediately, no reject/schedule-for-future UX since nothing has
// asked for that yet. Every row is enriched with createdByAdminEmail so a
// raw uuid never has to be the only clue to who set a ratio — same
// reasoning as partyId/partyLabel on the entries endpoint.
@Injectable()
export class AdminRevenueSplitRuleService {
  constructor(
    @InjectRepository(RevenueSplitRuleEntity)
    private readonly rules: Repository<RevenueSplitRuleEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly userLookupService: UserLookupService,
  ) {}

  async create(
    dto: CreateRevenueSplitRuleDto,
    adminId: string,
  ): Promise<RevenueSplitRuleRow> {
    // Cross-field rule — not expressible as a single-field class-validator
    // decorator, so it's an application-layer check, same as every other
    // business rule in this codebase.
    if (dto.riderPercent + dto.nodePercent + dto.platformPercent !== 100) {
      throw new InvalidRevenueSplitException();
    }

    const [rule, createdByAdminEmail] = await Promise.all([
      this.rules.save(
        this.rules.create({
          riderPercent: dto.riderPercent,
          nodePercent: dto.nodePercent,
          platformPercent: dto.platformPercent,
          createdByAdminId: adminId,
        }),
      ),
      this.userLookupService.getEmail(adminId),
    ]);

    return { ...rule, createdByAdminEmail };
  }

  async list(
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<RevenueSplitRuleRow>> {
    const offset = (query.page - 1) * query.limit;

    const items = await this.dataSource.query<RevenueSplitRuleRow[]>(
      `SELECT r.id, r."riderPercent", r."nodePercent", r."platformPercent",
              r."effectiveFrom", r."createdByAdminId", u.email AS "createdByAdminEmail",
              r."createdAt"
         FROM revenue_split_rules r
         JOIN users u ON u.id = r."createdByAdminId"
        ORDER BY r."effectiveFrom" DESC
        LIMIT $1 OFFSET $2`,
      [query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM revenue_split_rules`,
    );

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
