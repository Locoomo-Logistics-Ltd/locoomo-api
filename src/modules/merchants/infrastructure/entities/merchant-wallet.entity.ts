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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
