import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// Single-use fallback codes for a lost authenticator. Stored as SHA-256
// hashes (high-entropy, so a fast hash is fine); shown to the user once.
@Entity('mfa_recovery_codes')
@Index(['userId', 'codeHash'], { unique: true })
export class MfaRecoveryCodeEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  codeHash!: string;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
