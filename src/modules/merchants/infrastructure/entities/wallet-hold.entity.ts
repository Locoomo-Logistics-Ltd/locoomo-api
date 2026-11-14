import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';
import type { ApiKeyMode } from '../../domain/api-key';
import type { HoldStatus } from '../../domain/wallet';

// A shipment's quoted fee set aside until the parcel is received (captured)
// or never arrives (released). One per shipment.
@Entity('wallet_holds')
export class WalletHoldEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  walletId!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'uuid' })
  shipmentId!: string;

  @Column({ type: 'varchar' })
  status!: HoldStatus;

  @Column({ type: 'bigint', transformer: numericTransformer })
  amountKobo!: number;

  // What was actually charged at capture (may differ from the hold).
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: numericTransformer,
  })
  capturedKobo!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
