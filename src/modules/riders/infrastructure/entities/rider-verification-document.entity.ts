import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { RiderVerificationDocumentType } from '../../domain/rider-verification-document-type.enum';

@Entity('rider_verification_documents')
export class RiderVerificationDocumentEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  riderProfileId!: string;

  @Column({ type: 'enum', enum: RiderVerificationDocumentType })
  documentType!: RiderVerificationDocumentType;

  // Cloudinary asset id, `type: authenticated` (private delivery) — never a
  // public URL, since this may contain the rider's real name/photo from
  // another platform's dashboard (NDPA). View access goes through
  // CloudinaryService's signed delivery URL, generated on demand for Admin
  // review, not stored.
  @Column({ type: 'varchar' })
  cloudinaryPublicId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
