import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';
import type { ApiKeyMode } from '../../domain/api-key';

// One per merchant and mode. balanceKobo = Σ entries, heldKobo = Σ active
// holds: cached here, written only by WalletService under a row lock, and
// checked nightly by the reconciliation job.
@Entity('merchant_wallets')
export class MerchantWalletEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'bigint', default: 0, transformer: numericTransformer })
  balanceKobo!: number;

  @Column({ type: 'bigint', default: 0, transformer: numericTransformer })
  heldKobo!: number;

  // The merchant's low-balance alert (available below it → email +
  // wallet.low_balance, once until it recovers).
  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  lowBalanceThresholdKobo!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  lowBalanceAlertedAt!: Date | null;

  // Ops were told the balance fell below the tier's negative floor.
  @Column({ type: 'timestamptz', nullable: true })
  floorAlertedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
