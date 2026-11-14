import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';
import type { ApiKeyMode } from '../../domain/api-key';
import type { TopUpMethod, TopUpStatus } from '../../domain/wallet';

// One card payment or bank transfer into a merchant wallet.
@Entity('wallet_top_ups')
export class WalletTopUpEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar' })
  method!: TopUpMethod;

  @Column({ type: 'varchar' })
  status!: TopUpStatus;

  // The Paystack transaction reference (ours for cards, Paystack's for
  // transfers).
  @Column({ type: 'varchar', length: 120 })
  reference!: string;

  // What the payer paid.
  @Column({ type: 'bigint', transformer: numericTransformer })
  amountKobo!: number;

  @Column({ type: 'bigint', default: 0, transformer: numericTransformer })
  feeKobo!: number;

  // What reached the wallet (amount − fee for cards; the full amount for
  // transfers). Null until it succeeds.
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: numericTransformer,
  })
  creditedKobo!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  authorizationUrl!: string | null;

  @Column({ type: 'uuid', nullable: true })
  entryId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
