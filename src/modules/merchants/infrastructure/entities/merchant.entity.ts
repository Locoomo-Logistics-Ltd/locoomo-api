import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';
import type { MerchantLimits } from '../../domain/merchant-limits';
import {
  ExpectedMonthlyVolume,
  MerchantStatus,
  MerchantTier,
  MerchantType,
} from '../../domain/merchant.enums';

// An organisation that ships through Locoomo (plan §1). Owns its team,
// KYC, and — from M2/M4 — keys, shipments and wallet. Access is through
// merchant_members, never a users.role (plan E1).
@Entity('merchants')
@Index(['status', 'submittedAt'])
export class MerchantEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  type!: MerchantType;

  @Column({ type: 'varchar', default: MerchantStatus.DRAFT })
  status!: MerchantStatus;

  // Shown to buyers in notifications ("Your Ada Stores parcel…").
  @Column({ type: 'varchar', length: 120 })
  tradingName!: string;

  // Registered name (CAC) for businesses; the seller's full name for
  // individuals.
  @Column({ type: 'varchar', length: 200, nullable: true })
  legalName!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  category!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  storeUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  expectedMonthlyVolume!: ExpectedMonthlyVolume | null;

  @Column({ type: 'varchar', length: 254, nullable: true })
  contactEmail!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  contactPhone!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  addressLine1!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  addressLine2!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  state!: string | null;

  // RC (company) or BN (business name) number. Businesses only.
  @Column({ type: 'varchar', length: 20, nullable: true })
  cacNumber!: string | null;

  // Set on approval (defaults by type); admin-editable afterwards.
  @Column({ type: 'varchar', nullable: true })
  tier!: MerchantTier | null;

  // Per-merchant overrides on top of the tier defaults (merchant-limits.ts).
  @Column({ type: 'jsonb', nullable: true })
  limitOverrides!: Partial<MerchantLimits> | null;

  // A negotiated volume discount (percent) replacing the monthly tier;
  // null = use the tier (plan §8.3).
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  discountPercentOverride!: number | null;

  // D19: merchant may receive receivers' collection codes by webhook and
  // relay them itself. Admin-enabled on request.
  @Column({ type: 'boolean', default: false })
  receiverCodeRelay!: boolean;

  // Per-merchant kill switch: blocks new live shipments only.
  @Column({ type: 'boolean', default: false })
  creationPaused!: boolean;

  @Column({ type: 'varchar', length: 20, nullable: true })
  termsVersion!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  termsAcceptedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  termsAcceptedByUserId!: string | null;

  // Latest submission — the review queue's SLA clock.
  @Column({ type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  // Latest approve / request-changes / reject.
  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  // Reason given with request-changes or reject (shown to the merchant).
  @Column({ type: 'varchar', length: 1000, nullable: true })
  decisionNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  suspendedAt!: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  suspensionReason!: string | null;

  // Where reinstating returns to.
  @Column({ type: 'varchar', nullable: true })
  statusBeforeSuspension!: MerchantStatus | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
