import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ParcelSize } from '../../../../common/parcel-size.enum';
import type { FeeBreakdown } from '../../domain/fee-breakdown';
import { PaymentIntentStatus } from '../../domain/payment-intent-status.enum';
import { PaymentProviderName } from '../../domain/payment-provider-name.enum';

// consumerId/originNodeId/destinationNodeId are plain uuid columns, not
// relations — same cross-module-boundary reasoning as NodeOperatorProfile's
// userId/nodeId. providerReference is set at creation (we hand Paystack our
// own id as its reference, see PaymentProviderPort), so it's never null in
// practice, but stays nullable in the schema for a future provider that
// might not accept a caller-supplied reference.
@Entity('payment_intents')
export class PaymentIntentEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  consumerId!: string;

  @Column({ type: 'uuid' })
  originNodeId!: string;

  @Column({ type: 'uuid' })
  destinationNodeId!: string;

  @Column({ type: 'varchar' })
  receiverFullName!: string;

  @Column({ type: 'varchar' })
  receiverEmail!: string;

  @Column({ type: 'varchar' })
  receiverPhone!: string;

  @Column({ type: 'varchar', length: 500 })
  parcelDescription!: string;

  // enumName pins this to the shared "parcel_size_enum" Postgres type
  // (see the migration) rather than TypeORM auto-deriving a per-table name
  // — orders.parcelSize uses the same type, one enum, two usages.
  @Column({ type: 'enum', enum: ParcelSize, enumName: 'parcel_size_enum' })
  parcelSize!: ParcelSize;

  @Column({ type: 'jsonb' })
  feeBreakdown!: FeeBreakdown;

  // Denormalized off feeBreakdown.totalKobo so the webhook's amount check
  // and any future reporting never need to parse jsonb just to compare a
  // number.
  @Column({ type: 'int' })
  amountKobo!: number;

  @Index()
  @Column({
    type: 'enum',
    enum: PaymentIntentStatus,
    default: PaymentIntentStatus.PENDING,
  })
  status!: PaymentIntentStatus;

  @Column({ type: 'enum', enum: PaymentProviderName })
  provider!: PaymentProviderName;

  @Index({ unique: true, where: '"providerReference" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  providerReference!: string | null;

  // ~15 minute hold on the reserved capacity slot — see
  // ExpirePaymentIntentsService. Bounded window so an abandoned checkout
  // doesn't hold a Node slot hostage indefinitely.
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
