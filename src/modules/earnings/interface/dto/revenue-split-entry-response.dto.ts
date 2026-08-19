import { PayoutStatus } from '../../domain/payout-status.enum';
import { RevenueSplitPartyType } from '../../domain/party-type.enum';

// Own-view shape (rider's GET /earnings/mine, NodeOperator's
// GET /earnings/my-node) — the caller already knows who they are, so no
// party label needed here (see AdminRevenueSplitEntryResponseDto for the
// Admin view, which does need one).
export interface RevenueSplitEntryRow {
  id: string;
  orderId: string;
  orderTrackingCode: string;
  partyType: RevenueSplitPartyType;
  amountKobo: number;
  payoutStatus: PayoutStatus;
  paidAt: Date | null;
  createdAt: Date;
}

export class RevenueSplitEntryResponseDto {
  id!: string;
  orderId!: string;
  orderTrackingCode!: string;
  partyType!: RevenueSplitPartyType;
  amountKobo!: number;
  payoutStatus!: PayoutStatus;
  paidAt!: Date | null;
  createdAt!: Date;

  static fromRow(row: RevenueSplitEntryRow): RevenueSplitEntryResponseDto {
    const dto = new RevenueSplitEntryResponseDto();
    dto.id = row.id;
    dto.orderId = row.orderId;
    dto.orderTrackingCode = row.orderTrackingCode;
    dto.partyType = row.partyType;
    dto.amountKobo = row.amountKobo;
    dto.payoutStatus = row.payoutStatus;
    dto.paidAt = row.paidAt;
    dto.createdAt = row.createdAt;
    return dto;
  }
}
