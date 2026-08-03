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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
