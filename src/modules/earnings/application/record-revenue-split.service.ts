import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RevenueSplitNotConfiguredException } from '../domain/exceptions/revenue-split-not-configured.exception';
import { RevenueSplitPartyType } from '../domain/party-type.enum';
import { calculateSplit } from '../domain/split-calculator';
import { RevenueSplitEntryEntity } from '../infrastructure/entities/revenue-split-entry.entity';
import { RevenueSplitRuleEntity } from '../infrastructure/entities/revenue-split-rule.entity';

export interface RecordRevenueSplitFields {
  orderId: string;
  amountKobo: number;
  riderId: string;
  originNodeId: string;
}

// Narrow cross-module write export, called by handoffs' ConfirmCollectionService
// from inside its own transaction, right after an order transitions to
// COMPLETED — same manager-passing template as NodesService.releaseCapacitySlot.
// Reading the "current" rule via `manager` (not the injected repository, unlike
// PricingService.getCurrentRule) keeps the read inside the same transaction as
// the writes it produces, since this whole call must be atomic with the order's
// COMPLETED transition (decision #4: strict-consistency effect).
@Injectable()
export class RecordRevenueSplitService {
  async record(
    fields: RecordRevenueSplitFields,
    manager: EntityManager,
  ): Promise<void> {
    const rule = await manager
      .createQueryBuilder(RevenueSplitRuleEntity, 'rule')
      .where('rule.effectiveFrom <= :now', { now: new Date() })
      .orderBy('rule.effectiveFrom', 'DESC')
      .getOne();

    if (!rule) {
      throw new RevenueSplitNotConfiguredException();
    }

    const shares = calculateSplit(
      fields.amountKobo,
      rule.riderPercent,
      rule.nodePercent,
    );

    const repo = manager.getRepository(RevenueSplitEntryEntity);
    await repo.save([
      repo.create({
        orderId: fields.orderId,
        partyType: RevenueSplitPartyType.RIDER,
        partyId: fields.riderId,
        amountKobo: shares.riderShareKobo,
        splitRuleId: rule.id,
      }),
      repo.create({
        orderId: fields.orderId,
        partyType: RevenueSplitPartyType.NODE,
        partyId: fields.originNodeId,
        amountKobo: shares.nodeShareKobo,
        splitRuleId: rule.id,
      }),
      repo.create({
        orderId: fields.orderId,
        partyType: RevenueSplitPartyType.PLATFORM,
        partyId: null,
        amountKobo: shares.platformShareKobo,
        splitRuleId: rule.id,
      }),
    ]);
  }
}
