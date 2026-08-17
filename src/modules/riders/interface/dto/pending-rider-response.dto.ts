import { RiderDocumentResponseDto } from './rider-document-response.dto';

export class PendingRiderResponseDto {
  profileId!: string;
  userEmail!: string;
  userFirstName!: string;
  userLastName!: string;
  currentEmployer!: string;
  licenseNumber!: string | null;
  submittedAt!: Date;
  documents!: RiderDocumentResponseDto[];
}
