import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { MerchantDocumentKind } from '../../domain/merchant.enums';

// KYC documents (CAC certificate, …). One per kind — uploading again
// replaces it.
@Entity('merchant_documents')
@Unique(['merchantId', 'kind'])
export class MerchantDocumentEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  kind!: MerchantDocumentKind;

  // Cloudinary (authenticated) public id, always under the merchant's own
  // folder — checked on upload so one merchant can't attach another's file.
  @Column({ type: 'varchar', length: 255 })
  publicId!: string;

  @Column({ type: 'uuid' })
  uploadedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
