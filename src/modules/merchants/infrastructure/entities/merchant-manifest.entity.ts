import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';
import type { ManifestStatus } from '../../domain/manifest';

@Entity('merchant_manifests')
export class MerchantManifestEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  // MF-XXXX-XXXX: printed on the manifest document; the hub scans it.
  @Column({ type: 'varchar', length: 20 })
  reference!: string;

  @Column({ type: 'uuid' })
  hubNodeId!: string;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: ManifestStatus;

  @Column({ type: 'timestamptz', nullable: true })
  expectedDropAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  receivedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByApiKeyId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('merchant_manifest_items')
export class MerchantManifestItemEntity {
  @PrimaryColumn('uuid')
  manifestId!: string;

  @PrimaryColumn('uuid')
  shipmentId!: string;

  // false: scanned in under this manifest without being on it.
  @Column({ type: 'boolean', default: true })
  expected!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  receivedAt!: Date | null;
}
