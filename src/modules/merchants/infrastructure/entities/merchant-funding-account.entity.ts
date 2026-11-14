import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../../../common/database/numeric-transformer';

// A merchant's Paystack Dedicated Virtual Account: bank transfers to it
// top up the live wallet (plan §8.2, D11). One per merchant.
@Entity('merchant_funding_accounts')
export class MerchantFundingAccountEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar', default: 'paystack' })
  provider!: string;

  @Column({ type: 'varchar', length: 60 })
  customerCode!: string;

  @Column({ type: 'bigint', transformer: numericTransformer })
  customerId!: number;

  @Column({ type: 'varchar', length: 60 })
  providerAccountId!: string;

  @Column({ type: 'varchar', length: 120 })
  bankName!: string;

  @Column({ type: 'varchar', length: 60 })
  bankSlug!: string;

  @Column({ type: 'varchar', length: 20 })
  accountNumber!: string;

  @Column({ type: 'varchar', length: 200 })
  accountName!: string;

  // The sweep's high-water mark.
  @Column({ type: 'timestamptz', nullable: true })
  lastSweptAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
