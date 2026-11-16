import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BagStatus } from '../../domain/bag';

@Entity('bags')
export class BagEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // BAG-XXXX-XXXX, on the bag's tag; the courier sees it too.
  @Column({ type: 'varchar', length: 20 })
  code!: string;

  // The hub it was packed at.
  @Column({ type: 'uuid' })
  originNodeId!: string;

  @Column({ type: 'uuid' })
  destinationNodeId!: string;

  @Column({ type: 'varchar', length: 20, default: BagStatus.OPEN })
  status!: BagStatus;

  // `return`: merchant returns going back to their hub (reverse bag).
  @Column({ type: 'varchar', length: 10, default: 'forward' })
  direction!: 'forward' | 'return';

  @Column({ type: 'int', default: 0 })
  parcelCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  sealedAt!: Date | null;

  // null when it sealed itself (full).
  @Column({ type: 'uuid', nullable: true })
  sealedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  arrivedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  unpackedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  missingAlertedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
