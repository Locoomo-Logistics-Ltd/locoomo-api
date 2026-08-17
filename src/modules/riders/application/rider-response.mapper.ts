import { CloudinaryService } from '../infrastructure/cloudinary.service';
import { RiderProfileEntity } from '../infrastructure/entities/rider-profile.entity';
import { RiderVerificationDocumentEntity } from '../infrastructure/entities/rider-verification-document.entity';
import { RiderDocumentResponseDto } from '../interface/dto/rider-document-response.dto';
import { RiderResponseDto } from '../interface/dto/rider-response.dto';

// Shared by OnboardRiderService/ApproveRiderService/RiderQueryService
export function toRiderDocumentResponseDtos(
  documents: RiderVerificationDocumentEntity[],
  cloudinaryService: CloudinaryService,
): RiderDocumentResponseDto[] {
  return documents.map((document) => {
    const dto = new RiderDocumentResponseDto();
    dto.documentType = document.documentType;
    dto.uploadedAt = document.createdAt;
    dto.viewUrl = cloudinaryService.getSignedViewUrl(
      document.cloudinaryPublicId,
    );
    return dto;
  });
}

export function toRiderResponseDto(
  profile: RiderProfileEntity,
  documents: RiderVerificationDocumentEntity[],
  cloudinaryService: CloudinaryService,
): RiderResponseDto {
  const dto = new RiderResponseDto();
  dto.profileId = profile.id;
  dto.currentEmployer = profile.currentEmployer;
  dto.licenseNumber = profile.licenseNumber;
  dto.status = profile.status;
  dto.documents = toRiderDocumentResponseDtos(documents, cloudinaryService);
  return dto;
}
