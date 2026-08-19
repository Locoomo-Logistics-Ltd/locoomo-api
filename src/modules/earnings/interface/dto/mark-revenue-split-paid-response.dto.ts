import { PayoutStatus } from '../../domain/payout-status.enum';

export interface MarkRevenueSplitPaidResult {
  id: string;
  payoutStatus: PayoutStatus;
  paidAt: Date | null;
  paidByAdminId: string | null;
  paidByAdminEmail: string | null;
}

export class MarkRevenueSplitPaidResponseDto {
  id!: string;
  payoutStatus!: PayoutStatus;
  paidAt!: Date | null;
  paidByAdminId!: string | null;
  paidByAdminEmail!: string | null;

  static fromResult(
    result: MarkRevenueSplitPaidResult,
  ): MarkRevenueSplitPaidResponseDto {
    const dto = new MarkRevenueSplitPaidResponseDto();
    dto.id = result.id;
    dto.payoutStatus = result.payoutStatus;
    dto.paidAt = result.paidAt;
    dto.paidByAdminId = result.paidByAdminId;
    dto.paidByAdminEmail = result.paidByAdminEmail;
    return dto;
  }
}
