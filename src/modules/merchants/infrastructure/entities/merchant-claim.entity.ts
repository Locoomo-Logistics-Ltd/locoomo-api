import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';
import type { ApiKeyMode } from '../../domain/api-key';
import type { ClaimSource, ClaimStatus, ClaimType } from '../../domain/claim';

@Entity('merchant_claims')
export class MerchantClaimEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'uuid' })
  shipmentId!: string;

  @Column({ type: 'varchar', length: 20 })
  type!: ClaimType;

  @Column({ type: 'varchar', length: 20 })
  source!: ClaimSource;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: ClaimStatus;

  @Column({ type: 'varchar', length: 2000 })
  description!: string;

  // Cloudinary public ids under merchants/<id>/claims/.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  evidence!: string[];

  // Snapshot of the shipment's declared value when the claim was filed.
  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  declaredValueKobo!: number | null;

  // The declared value capped by the merchant's claim cap, at filing.
  @Column({ type: 'bigint', transformer: numericTransformer })
  maxPayoutKobo!: number;

  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  payoutKobo!: number | null;

  // The two-admin approval for the payout (E12), while one is raised.
  @Column({ type: 'uuid', nullable: true })
  payoutApprovalId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  walletEntryId!: string | null;

  // Shown to the merchant with the decision.
  @Column({ type: 'varchar', length: 1000, nullable: true })
  merchantNote!: string | null;

  // Admins only: the investigation.
  @Column({ type: 'varchar', length: 2000, nullable: true })
  internalNote!: string | null;

  @Column({ type: 'uuid', nullable: true })
  filedByUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  filedByApiKeyId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
