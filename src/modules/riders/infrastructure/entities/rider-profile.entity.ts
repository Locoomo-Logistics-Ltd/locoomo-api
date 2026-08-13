import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RiderStatus } from '../../domain/rider-status.enum';

@Entity('rider_profiles')
export class RiderProfileEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  currentEmployer!: string;

  @Index()
  @Column({ type: 'enum', enum: RiderStatus, default: RiderStatus.PENDING })
  status!: RiderStatus;

  // Direct mirror of NodeEntity.currentCount — atomic counter under
  // RiderCapacityService's SELECT ... FOR UPDATE, caps concurrent
  // deliveries at MAX_ACTIVE_ORDERS_PER_RIDER.
  @Column({ type: 'int', default: 0 })
  currentActiveOrderCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
