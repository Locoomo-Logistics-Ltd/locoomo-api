import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import { RecordRevenueSplitService } from '../../earnings/application/record-revenue-split.service';
import { InvalidDiscountTiersException } from '../domain/exceptions/merchant.exceptions';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import type { ApiKeyMode } from '../domain/api-key';
import {
  COUNTED_STATUSES,
  DEFAULT_TIERS,
  DiscountTier,
  maxDiscountKobo,
  normaliseTiers,
  tierFor,
} from '../domain/volume-discount';
import { VolumeDiscountTierSetEntity } from '../infrastructure/entities/volume-discount-tier-set.entity';

const CACHE_MS = 10 * 60 * 1000;

export interface MerchantDiscount {
  // 0–50: what's taken off the standard price this month.
  percent: number;
  source: 'tier' | 'negotiated';
  // The tier basis: last calendar month (Lagos) in this mode.
  basis: { month: string; shipments: number };
  tier: DiscountTier;
  nextTier: DiscountTier | null;
}

// A merchant's volume discount (plan §8.3, D9): a negotiated percentage if
// Locoomo set one, otherwise the tier earned by last month's shipments.
// Recomputed at most every 10 minutes per merchant and mode.
@Injectable()
export class MerchantPricingService {
  private readonly cache = new Map<
    string,
    { value: MerchantDiscount; until: number }
  >();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly splits: RecordRevenueSplitService,
    private readonly audit: AuditService,
  ) {}

  async currentTiers(): Promise<DiscountTier[]> {
    const set = await this.dataSource.manager
      .getRepository(VolumeDiscountTierSetEntity)
      .createQueryBuilder('t')
      .where('t."effectiveFrom" <= now()')
      .orderBy('t."effectiveFrom"', 'DESC')
      .addOrderBy('t."createdAt"', 'DESC')
      .getOne();
    return set?.tiers ?? [...DEFAULT_TIERS];
  }

  async discountFor(
    merchantId: string,
    mode: ApiKeyMode,
  ): Promise<MerchantDiscount> {
    const key = `${merchantId}:${mode}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      return cached.value;
    }
    const [row] = await this.dataSource.query<
      { override: string | null; shipments: number; month: string }[]
    >(
      `WITH bounds AS (
         SELECT (date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') - interval '1 month') AS start,
                date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AS stop
       )
       SELECT m."discountPercentOverride" AS override,
              to_char((SELECT start FROM bounds), 'YYYY-MM') AS month,
              (SELECT count(*)::int FROM merchant_shipments s
                WHERE s."merchantId" = m.id AND s.mode = $2
                  AND s.status = ANY($3)
                  AND s."createdAt" >= ((SELECT start FROM bounds) AT TIME ZONE 'Africa/Lagos')
                  AND s."createdAt" < ((SELECT stop FROM bounds) AT TIME ZONE 'Africa/Lagos')
              ) AS shipments
         FROM merchants m WHERE m.id = $1`,
      [merchantId, mode, COUNTED_STATUSES],
    );
    const tiers = await this.currentTiers();
    const shipments = row?.shipments ?? 0;
    const { current, next } = tierFor(shipments, tiers);
    const negotiated =
      row?.override !== null && row?.override !== undefined
        ? Number(row.override)
        : null;
    const value: MerchantDiscount = {
      percent: negotiated ?? current.percent,
      source: negotiated !== null ? 'negotiated' : 'tier',
      basis: { month: row?.month ?? '', shipments },
      tier: current,
      nextTier: negotiated !== null ? null : next,
    };
    this.cache.set(key, { value, until: Date.now() + CACHE_MS });
    return value;
  }

  // Admin (`finance`): a new tier set, effective now. Old sets stay.
  async setTiers(
    tiers: DiscountTier[],
    actor: { userId: string; context: AuditRequestContext },
  ): Promise<DiscountTier[]> {
    const normalised = normaliseTiers(tiers);
    if (!normalised) {
      throw new InvalidDiscountTiersException();
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.save(
        manager.create(VolumeDiscountTierSetEntity, {
          tiers: normalised,
          effectiveFrom: new Date(),
          createdByAdminId: actor.userId,
        }),
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId, role: 'admin' },
          action: 'pricing.volume_tiers_set',
          metadata: { tiers: normalised },
          context: actor.context,
        },
        manager,
      );
    });
    this.forget();
    return normalised;
  }

  // Admin (`finance`): a negotiated discount for one merchant, or null to
  // go back to the tier.
  async setMerchantDiscount(
    merchantId: string,
    percent: number | null,
    actor: { userId: string; context: AuditRequestContext },
  ): Promise<MerchantDiscount> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await manager.findOneBy(MerchantEntity, {
        id: merchantId,
      });
      if (!merchant) {
        throw new EntityNotFoundException('Merchant', merchantId);
      }
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId, role: 'admin' },
          action: 'merchant.discount_set',
          merchantId,
          before: { discountPercentOverride: merchant.discountPercentOverride },
          after: { discountPercentOverride: percent },
          context: actor.context,
        },
        manager,
      );
      merchant.discountPercentOverride = percent;
      await manager.save(merchant);
    });
    this.forget(merchantId);
    return this.discountFor(merchantId, 'live');
  }

  // After an admin changes tiers or a merchant's override.
  forget(merchantId?: string): void {
    if (!merchantId) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${merchantId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  // The discount on one fee, capped at the platform share (E7).
  async discountCap(
    totalKobo: number,
    destinationFeeKobo: number,
  ): Promise<number> {
    const platformPercent = await this.splits.currentPlatformPercent(
      this.dataSource.manager,
    );
    return maxDiscountKobo(totalKobo, destinationFeeKobo, platformPercent);
  }
}
