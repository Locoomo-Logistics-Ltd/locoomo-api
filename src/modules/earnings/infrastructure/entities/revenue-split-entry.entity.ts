import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { PayoutStatus } from '../../domain/payout-status.enum';
import { RevenueSplitPartyType } from '../../domain/party-type.enum';

// One row per party per completed order (rider, origin Node, platform) —
// normalized rather than one wide row with three amount columns, so "give
// me rider X's earnings" or "give me Node Y's earnings" is a plain WHERE,
// and a future 4th party type is a new enum value, not a schema change.
// orderId/partyId are plain uuid columns, not relations — cross-module
// boundary (orderId real FK still exists at the DB level, hand-written in
// the migration; partyId is polymorphic across party types, so no FK is
// possible there).
@Entity('revenue_split_entries')
export class RevenueSplitEntryEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  orderId!: string;

  @Index()
  @Column({
    type: 'enum',
    enum: RevenueSplitPartyType,
    enumName: 'revenue_split_party_type_enum',
  })
  partyType!: RevenueSplitPartyType;

  // Null for PLATFORM — no specific party.
  @Column({ type: 'uuid', nullable: true })
  partyId!: string | null;

  @Column({ type: 'int' })
  amountKobo!: number;

  // Which rule this entry's amountKobo was computed from — snapshotted so a
  // historical entry stays explainable even after the ratio changes, same
  // principle as PaymentIntent.feeBreakdown never being recomputed.
  @Column({ type: 'uuid' })
  splitRuleId!: string;

  @Column({
    type: 'enum',
    enum: PayoutStatus,
    enumName: 'payout_status_enum',
    default: PayoutStatus.PENDING,
  })
  payoutStatus!: PayoutStatus;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  paidByAdminId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
