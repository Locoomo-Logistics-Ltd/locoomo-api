import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// Append-only, same reasoning as PricingRuleEntity — real money is split
// off this table, so a historical order's revenue-split entries must stay
// explainable even after the ratio changes. A new ratio is a new row, never
// an UPDATE; "current" is just the latest row with effectiveFrom <= now().
// createdByAdminId is a plain uuid column, not a relation — cross-module
// boundary, same as pricing_rules.createdByAdminId.
@Entity('revenue_split_rules')
export class RevenueSplitRuleEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'int' })
  riderPercent!: number;

  @Column({ type: 'int' })
  nodePercent!: number;

  @Column({ type: 'int' })
  platformPercent!: number;

  @Index()
  @Column({ type: 'timestamptz', default: () => 'now()' })
  effectiveFrom!: Date;

  @Column({ type: 'uuid' })
  createdByAdminId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
