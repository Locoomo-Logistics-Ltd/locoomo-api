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

  // Nullable at the DB level — required by OnboardRiderDto for every new
  // rider, but riders onboarded before this field existed have no way to
  // backfill it yet (no update endpoint exists). No format validation
  // beyond length: Nigerian driver's license numbers have no single
  // confirmed canonical format in the PRD/CTO decisions, so a strict regex
  // isn't invented here.
  @Column({ type: 'varchar', nullable: true })
  licenseNumber!: string | null;

  @Index()
  @Column({ type: 'enum', enum: RiderStatus, default: RiderStatus.PENDING })
  status!: RiderStatus;

  // Direct mirror of NodeEntity.currentCount — atomic counter under
  // RiderCapacityService's SELECT ... FOR UPDATE, caps concurrent
  // deliveries at MAX_ACTIVE_ORDERS_PER_RIDER.
  @Column({ type: 'int', default: 0 })
  currentActiveOrderCount!: number;

  // Payout bank account — all five nullable, all-or-nothing (either every
  // field is set together by SetRiderPayoutAccountService after a
  // successful Paystack resolve, or every field is null). payoutAccountName
  // is always Paystack-resolved, never client-typed — see
  // PaystackBankService.resolveAccountNumber. payoutAccountVerifiedAt
  // doubles as the "is this configured" signal (GET /riders/me's
  // payoutAccountConfigured).
  @Column({ type: 'varchar', nullable: true })
  payoutBankCode!: string | null;

  @Column({ type: 'varchar', nullable: true })
  payoutBankName!: string | null;

  @Column({ type: 'varchar', nullable: true })
  payoutAccountNumber!: string | null;

  @Column({ type: 'varchar', nullable: true })
  payoutAccountName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  payoutAccountVerifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
