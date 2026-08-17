import { RiderStatus } from '../../domain/rider-status.enum';
import { RiderDocumentResponseDto } from './rider-document-response.dto';

export class RiderResponseDto {
  profileId!: string;
  currentEmployer!: string;
  licenseNumber!: string | null;
  status!: RiderStatus;
  documents!: RiderDocumentResponseDto[];
}
