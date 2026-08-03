import { RiderVerificationDocumentType } from '../../domain/rider-verification-document-type.enum';

export class RiderDocumentResponseDto {
  documentType!: RiderVerificationDocumentType;
  uploadedAt!: Date;
  // Signed, time-limited Cloudinary delivery URL, generated fresh on every
  // response — never the raw public_id or a permanent public link (NDPA;
  // see rider-verification-document.entity.ts).
  viewUrl!: string;
}
