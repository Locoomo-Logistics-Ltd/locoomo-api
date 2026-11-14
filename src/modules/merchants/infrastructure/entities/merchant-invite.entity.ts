import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { MerchantRole } from '../../domain/merchant.enums';

// Team invitation by email. The token is single-use and stored hashed
// only; the invitee signs in (or signs up and verifies) with the invited
// address, then accepts.
@Entity('merchant_invites')
export class MerchantInviteEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  // Lowercased.
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ type: 'varchar' })
  role!: MerchantRole;

  @Column({ type: 'varchar', unique: true })
  tokenHash!: string;

  @Column({ type: 'uuid' })
  invitedByUserId!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acceptedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
