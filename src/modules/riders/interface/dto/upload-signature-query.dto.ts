import { IsIn } from 'class-validator';
import { RiderVerificationDocumentType } from '../../domain/rider-verification-document-type.enum';

const DOCUMENT_TYPES = Object.values(RiderVerificationDocumentType);

export class UploadSignatureQueryDto {
  @IsIn(DOCUMENT_TYPES, {
    message: `documentType must be one of: ${DOCUMENT_TYPES.join(', ')}`,
  })
  documentType!: RiderVerificationDocumentType;
}
