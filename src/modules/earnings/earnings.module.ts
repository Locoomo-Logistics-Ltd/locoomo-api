import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { NodeOperatorsModule } from '../node-operators/node-operators.module';
import { AdminRevenueSplitRuleService } from './application/admin-revenue-split-rule.service';
import { MarkRevenueSplitPaidService } from './application/mark-revenue-split-paid.service';
import { RecordRevenueSplitService } from './application/record-revenue-split.service';
import { RevenueSplitQueryService } from './application/revenue-split-query.service';
import { RevenueSplitEntryEntity } from './infrastructure/entities/revenue-split-entry.entity';
import { RevenueSplitRuleEntity } from './infrastructure/entities/revenue-split-rule.entity';
import { AdminRevenueSplitController } from './interface/admin-revenue-split.controller';
import { MyEarningsController } from './interface/my-earnings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([RevenueSplitRuleEntity, RevenueSplitEntryEntity]),
    // NodeOperatorQueryService.getNodeIdForUser — resolving a NodeOperator's
    // own Node for GET /earnings/my-node.
    // IdentityModule: UserLookupService.getEmail — resolving createdByAdminId/
    // paidByAdminId to a human-readable email, same reasoning as partyLabel.
    NodeOperatorsModule,
    IdentityModule,
  ],
  controllers: [AdminRevenueSplitController, MyEarningsController],
  providers: [
    AdminRevenueSplitRuleService,
    RecordRevenueSplitService,
    RevenueSplitQueryService,
    MarkRevenueSplitPaidService,
  ],
  // Exported so handoffs can record a completed order's revenue split
  // inside its own transaction — never by reaching into earnings'
  // domain/infrastructure directly.
  exports: [RecordRevenueSplitService],
})
export class EarningsModule {}
