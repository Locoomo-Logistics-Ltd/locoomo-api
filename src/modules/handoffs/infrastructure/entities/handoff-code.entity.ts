import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { HandoffCodeType } from '../../domain/handoff-code-type.enum';

// One entity for all three handoff-code moments (pickup, arrival,
// collection) — same shape, only `type` and who's allowed to request one
// differ. orderId is a plain uuid, not a relation (cross-module boundary,
// same reasoning as every other Order-referencing column elsewhere).
@Entity('handoff_codes')
export class HandoffCodeEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({
    type: 'enum',
    enum: HandoffCodeType,
    enumName: 'handoff_code_type_enum',
  })
  type!: HandoffCodeType;

  @Column({ type: 'varchar' })
  codeHash!: string;

  // Null for RECEIVER_COLLECTION (system-generated, no requesting user) —
  // set for RIDER_PICKUP/RIDER_ARRIVAL to the rider who requested it.
  @Column({ type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  // Durable brute-force lockout counter — incremented on a wrong-code
  // attempt via a write that survives even when the surrounding confirm
  // transaction rolls back (see ConfirmHandoffService).
  @Column({ type: 'int', default: 0 })
  failedAttempts!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
