import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type { VehicleRate } from '../../domain/vehicle-pricing';

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

  // Flat fee paid entirely to the destination Node on order completion —
  // a dedicated pass-through, not folded into the rider/origin-Node/platform
  // split (see RevenueSplitPartyType.DESTINATION_NODE). DEFAULT 0 exists
  // only so pre-feature rows stay valid; every new rule sets it explicitly.
  @Column({ type: 'int', default: 0 })
  destinationFeeKobo!: number;

  // Road km ≈ straight-line km × this, when no courier has measured the
  // Node pair yet (see payments/domain/vehicle-pricing.ts).
  @Column({ type: 'double precision', default: 1.4 })
  roadDistanceFactor!: number;

  // Explicit rates for vehicle classes other than motorbike (whose rate is
  // baseFeeKobo/perKmRateKobo above), e.g. { car: { baseFeeKobo,
  // perKmRateKobo } }. Classes not listed use the default multipliers.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  vehicleRates!: Partial<Record<string, VehicleRate>>;

  @Index()
  @Column({ type: 'timestamptz', default: () => 'now()' })
  effectiveFrom!: Date;

  @Column({ type: 'uuid' })
  createdByAdminId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
