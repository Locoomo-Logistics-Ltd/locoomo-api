import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';
import type { ApiKeyMode } from '../../domain/api-key';
import type { WalletEntryType } from '../../domain/wallet';

// Append-only ledger line. Never updated or deleted.
@Entity('wallet_entries')
export class WalletEntryEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  walletId!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar', length: 40 })
  type!: WalletEntryType;

  // Signed: credits positive, debits negative.
  @Column({ type: 'bigint', transformer: numericTransformer })
  amountKobo!: number;

  @Column({ type: 'bigint', transformer: numericTransformer })
  balanceAfterKobo!: number;

  @Column({ type: 'varchar', length: 300 })
  description!: string;

  @Column({ type: 'uuid', nullable: true })
  shipmentId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  holdId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvalId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  // Idempotency for credits from outside (a Paystack transaction id, M4b).
  @Column({ type: 'varchar', length: 120, nullable: true })
  externalRef!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
