import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MerchantRole } from '../../domain/merchant.enums';

// A user's seat on a merchant's team. v1: one merchant per user (unique
// userId) so the merchant is implicit in every request; the table is
// already many-to-many-shaped for agencies later. Exactly one owner per
// merchant (partial unique index in the migration).
@Entity('merchant_members')
@Index(['merchantId'])
export class MerchantMemberEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  role!: MerchantRole;

  @Column({ type: 'uuid', nullable: true })
  invitedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
