import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { RiderVerificationDocumentType } from '../../domain/rider-verification-document-type.enum';

const DOCUMENT_TYPES = Object.values(RiderVerificationDocumentType);

// cloudinaryPublicId is client-reported after they've completed the signed
// direct-to-Cloudinary upload (see GET /riders/verification/upload-signature)
// — OnboardRiderService confirms it actually exists via CloudinaryService
// before trusting it.
export class OnboardRiderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  currentEmployer!: string;

  // No format regex — no single confirmed canonical format for a Nigerian
  // driver's license number exists in the PRD/CTO decisions, so this is
  // deliberately loose (length only) rather than an invented rule.
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  licenseNumber!: string;

  @IsIn(DOCUMENT_TYPES, {
    message: `documentType must be one of: ${DOCUMENT_TYPES.join(', ')}`,
  })
  documentType!: RiderVerificationDocumentType;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  cloudinaryPublicId!: string;
}
