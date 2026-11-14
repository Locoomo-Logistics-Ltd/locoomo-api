import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';

// The merchant's settlement account: closure refunds and (later) payouts.
// Resolved through Paystack — the account name is never typed by the
// merchant. Number encrypted at rest (SecretBox 'bank-account').
@Entity('merchant_bank_accounts')
export class MerchantBankAccountEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', unique: true })
  merchantId!: string;

  @Column({ type: 'varchar', length: 10 })
  bankCode!: string;

  @Column({ type: 'varchar', length: 150 })
  bankName!: string;

  @Column({ type: 'text' })
  accountNumberSealed!: string;

  @Column({ type: 'varchar', length: 4 })
  accountNumberLast4!: string;

  // As returned by Paystack.
  @Column({ type: 'varchar', length: 200 })
  accountName!: string;

  // 0..1 similarity to the merchant's legal/trading/director names
  // (domain/name-match.ts). A hint for the reviewer, not a gate.
  @Column({
    type: 'numeric',
    precision: 4,
    scale: 3,
    transformer: numericTransformer,
  })
  nameMatchScore!: number;

  @Column({ type: 'timestamptz' })
  verifiedAt!: Date;

  @Column({ type: 'uuid' })
  setByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
