import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';
import type { ImportSource, ImportStatus } from '../../domain/shipment-import';

@Entity('shipment_imports')
export class ShipmentImportEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar' })
  source!: ImportSource;

  @Column({ type: 'varchar' })
  status!: ImportStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  fileName!: string | null;

  @Column({ type: 'int' })
  totalRows!: number;

  @Column({ type: 'int', default: 0 })
  createdCount!: number;

  @Column({ type: 'int', default: 0 })
  failedCount!: number;

  // Why the whole import stopped (e.g. the account can no longer create
  // shipments). Row errors live on the rows.
  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByKeyId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  // A worker's claim; another may take over after this.
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
