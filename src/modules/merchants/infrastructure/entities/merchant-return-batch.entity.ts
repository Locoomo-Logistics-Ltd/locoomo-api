import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';
import type { ReturnBatchStatus } from '../../domain/return-batch';

@Entity('merchant_return_batches')
export class MerchantReturnBatchEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  // Public: what the Node looks the batch up by (RB-XXXX-XXXX).
  @Column({ type: 'varchar', length: 20 })
  reference!: string;

  @Column({ type: 'uuid' })
  nodeId!: string;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: ReturnBatchStatus;

  // The secret code: hashed to check it, sealed so the merchant's team can
  // see it again in the dashboard.
  @Column({ type: 'varchar' })
  codeHash!: string;

  @Column({ type: 'text' })
  codeSealed!: string;

  @Column({ type: 'timestamptz' })
  codeExpiresAt!: Date;

  @Column({ type: 'int', default: 0 })
  failedAttempts!: number;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByApiKeyId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  collectedAt!: Date | null;

  // The Node staff member who handed it over.
  @Column({ type: 'uuid', nullable: true })
  collectedByUserId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  collectorName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('merchant_return_batch_items')
export class MerchantReturnBatchItemEntity {
  @PrimaryColumn('uuid')
  batchId!: string;

  @PrimaryColumn('uuid')
  shipmentId!: string;

  // In an open batch. A shipment is in at most one active batch.
  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  collectedAt!: Date | null;
}
