import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

// One TOTP authenticator per user. A row with confirmedAt = null is an
// enrolment in progress (setup shown, first code not yet entered) and does
// NOT protect the account yet.
@Entity('mfa_factors')
export class MfaFactorEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  // SecretBox-sealed TOTP seed — never stored or logged in the clear.
  @Column({ type: 'varchar' })
  secretSealed!: string;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  // Last accepted TOTP time step: a code can't be used twice.
  @Column({ type: 'bigint', nullable: true })
  lastUsedStep!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
