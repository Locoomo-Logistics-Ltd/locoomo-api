import { Injectable } from '@nestjs/common';
import { CloudinaryService } from '../infrastructure/cloudinary.service';
import { UploadSignatureResponseDto } from '../interface/dto/upload-signature-response.dto';
import { RiderVerificationDocumentType } from '../domain/rider-verification-document-type.enum';

@Injectable()
export class GetUploadSignatureService {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  generate(
    userId: string,
    documentType: RiderVerificationDocumentType,
  ): UploadSignatureResponseDto {
    // Scoped per-user, per-document-type — a second document type later is
    // just another folder segment, not a redesign.
    const folder = `riders/${userId}/verification/${documentType}`;
    const signature = this.cloudinaryService.generateUploadSignature(folder);

    const dto = new UploadSignatureResponseDto();
    dto.signature = signature.signature;
    dto.timestamp = signature.timestamp;
    dto.apiKey = signature.apiKey;
    dto.cloudName = signature.cloudName;
    dto.folder = signature.folder;
    return dto;
  }
}
