import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { DiscountTier } from '../../domain/volume-discount';

// A version of the volume discount tiers. The one with the latest
// effectiveFrom not in the future applies; old versions stay for history.
@Entity('volume_discount_tier_sets')
export class VolumeDiscountTierSetEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'jsonb' })
  tiers!: DiscountTier[];

  @Column({ type: 'timestamptz' })
  effectiveFrom!: Date;

  @Column({ type: 'uuid', nullable: true })
  createdByAdminId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
