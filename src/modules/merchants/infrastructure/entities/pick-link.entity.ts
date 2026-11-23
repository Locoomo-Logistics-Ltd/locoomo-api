import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';

@Entity('pick_links')
export class PickLinkEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar', length: 64 })
  reference!: string;

  // The link's token: hashed to look it up, sealed to show it again.
  @Column({ type: 'varchar' })
  tokenHash!: string;

  @Column({ type: 'text' })
  tokenSealed!: string;

  // A POST /shipments body without destinationNodeId (validated at creation).
  @Column({ type: 'jsonb' })
  draft!: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  hidePrices!: boolean;

  @Column({ type: 'varchar', length: 12, default: 'open' })
  status!: 'open' | 'used' | 'cancelled';

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  shipmentId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByApiKeyId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
