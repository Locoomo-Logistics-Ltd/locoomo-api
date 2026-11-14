import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { DirectorIdType } from '../../domain/merchant.enums';

// Owner (individual seller) or director (business) identity for KYC.
// The ID number is encrypted at rest (SecretBox 'merchant-kyc'); only the
// last 4 digits are readable without an audited admin reveal.
@Entity('merchant_directors')
@Index(['merchantId'])
export class MerchantDirectorEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar', length: 150 })
  fullName!: string;

  @Column({ type: 'varchar' })
  idType!: DirectorIdType;

  @Column({ type: 'text' })
  idNumberSealed!: string;

  @Column({ type: 'varchar', length: 4 })
  idNumberLast4!: string;

  // Cloudinary (authenticated) public id of the ID image.
  @Column({ type: 'varchar', length: 255 })
  idDocumentPublicId!: string;

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
