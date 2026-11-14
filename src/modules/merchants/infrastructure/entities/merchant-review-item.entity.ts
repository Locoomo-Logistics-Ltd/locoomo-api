import { Column, Entity, PrimaryColumn } from 'typeorm';
import { ReviewDecision, ReviewItemKey } from '../../domain/merchant.enums';

// The KYC reviewer's latest decision on one onboarding section. Deleted
// when the merchant edits that section, so "rejected" never sticks to
// something that has since been fixed.
@Entity('merchant_review_items')
export class MerchantReviewItemEntity {
  @PrimaryColumn('uuid')
  merchantId!: string;

  @PrimaryColumn('varchar')
  key!: ReviewItemKey;

  @Column({ type: 'varchar' })
  decision!: ReviewDecision;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid' })
  decidedByUserId!: string;

  @Column({ type: 'timestamptz' })
  decidedAt!: Date;
}
