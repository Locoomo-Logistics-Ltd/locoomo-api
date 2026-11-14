import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ApprovalStatus } from '../../domain/approval-status.enum';

// Maker-checker (plan E12): an admin *requests* a sensitive action (manual
// wallet adjustment, claim payout, closure refund, …); a *different* admin
// holding the action's permission approves it, and only then does it run.
@Entity('approval_requests')
@Index(['status', 'createdAt'])
@Index(['merchantId', 'createdAt'])
export class ApprovalRequestEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // Registered action key, e.g. 'wallet.manual_adjustment'.
  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'varchar' })
  status!: ApprovalStatus;

  // Input for the action's executor — validated by the executor when the
  // request is created, executed verbatim on approval.
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  // One-line human summary shown in the approvals queue,
  // e.g. "Credit ₦25,000.00 to Ada Stores (claim #123)".
  @Column({ type: 'varchar', length: 300 })
  summary!: string;

  @Column({ type: 'varchar', length: 1000 })
  reason!: string;

  @Column({ type: 'uuid', nullable: true })
  merchantId!: string | null;

  @Column({ type: 'uuid' })
  requestedByUserId!: string;

  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  decisionNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  // Executor's return value (e.g. the wallet entry id) for the record.
  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
