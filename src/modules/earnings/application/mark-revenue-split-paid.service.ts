import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { UserLookupService } from '../../identity/application/user-lookup.service';
import { PayoutStatus } from '../domain/payout-status.enum';
import { RevenueSplitEntryEntity } from '../infrastructure/entities/revenue-split-entry.entity';
import { MarkRevenueSplitPaidResult } from '../interface/dto/mark-revenue-split-paid-response.dto';

// Doesn't move money — just records that Admin settled this entry
// off-system. Idempotent: marking an already-paid entry again is harmless
// (no double-payment risk, since nothing here actually pays anyone), so a
// double-click just returns the existing paid state rather than erroring.
@Injectable()
export class MarkRevenueSplitPaidService {
  constructor(
    @InjectRepository(RevenueSplitEntryEntity)
    private readonly entries: Repository<RevenueSplitEntryEntity>,
    private readonly userLookupService: UserLookupService,
  ) {}

  async markPaid(
    entryId: string,
    adminId: string,
  ): Promise<MarkRevenueSplitPaidResult> {
    const entry = await this.entries.findOneBy({ id: entryId });
    if (!entry) {
      throw new EntityNotFoundException('RevenueSplitEntry', entryId);
    }

    if (entry.payoutStatus === PayoutStatus.PAID) {
      // paidByAdminId is guaranteed set once payoutStatus is PAID — the two
      // are always written together, below.
      const paidByAdminEmail = await this.userLookupService.getEmail(
        entry.paidByAdminId!,
      );
      return { ...entry, paidByAdminEmail };
    }

    entry.payoutStatus = PayoutStatus.PAID;
    entry.paidAt = new Date();
    entry.paidByAdminId = adminId;

    const [saved, paidByAdminEmail] = await Promise.all([
      this.entries.save(entry),
      this.userLookupService.getEmail(adminId),
    ]);
    return { ...saved, paidByAdminEmail };
  }
}
