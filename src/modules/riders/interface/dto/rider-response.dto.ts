import { RiderStatus } from '../../domain/rider-status.enum';
import { RiderDocumentResponseDto } from './rider-document-response.dto';

export class RiderResponseDto {
  profileId!: string;
  currentEmployer!: string;
  licenseNumber!: string | null;
  status!: RiderStatus;
  documents!: RiderDocumentResponseDto[];
  // Own-view payout account fields — shown in full, no reason to mask a
  // rider's own data from themselves. payoutAccountConfigured is the
  // dashboard-prompt signal ("set up your payout account").
  payoutAccountConfigured!: boolean;
  payoutBankCode!: string | null;
  payoutBankName!: string | null;
  payoutAccountNumber!: string | null;
  payoutAccountName!: string | null;
}
