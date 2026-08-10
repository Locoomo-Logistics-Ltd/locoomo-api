import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// Append-only, same reasoning as OrderEvent — real money is
// priced off this table, so a historical order's fee must stay explainable
// even after rates change. "Current rate" is just the latest row with
// effectiveFrom <= now(); changing a price is a new row, never an UPDATE.
// `createdByAdminId` is a plain uuid column, not a relation, per the usual
// cross-module boundary (importing UserEntity here would violate it).
@Entity('pricing_rules')
export class PricingRuleEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'int' })
  baseFeeKobo!: number;

  @Column({ type: 'int' })
  perKmRateKobo!: number;

  @Index()
  @Column({ type: 'timestamptz', default: () => 'now()' })
  effectiveFrom!: Date;

  @Column({ type: 'uuid' })
  createdByAdminId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
