import { PayoutStatus } from '../../domain/payout-status.enum';
import { RevenueSplitPartyType } from '../../domain/party-type.enum';

// Admin's view — includes partyId + a human-readable partyLabel (the
// rider's email, the Node's name, or "Platform") since Admin needs to know
// who to actually pay, unlike a party viewing their own entries.
// paidByAdminEmail mirrors that same treatment for paidByAdminId, once an
// entry has been marked paid.
export interface AdminRevenueSplitEntryRow {
  id: string;
  orderId: string;
  orderTrackingCode: string;
  partyType: RevenueSplitPartyType;
  partyId: string | null;
  partyLabel: string;
  amountKobo: number;
  payoutStatus: PayoutStatus;
  paidAt: Date | null;
  paidByAdminId: string | null;
  paidByAdminEmail: string | null;
  createdAt: Date;
}

export class AdminRevenueSplitEntryResponseDto {
  id!: string;
  orderId!: string;
  orderTrackingCode!: string;
  partyType!: RevenueSplitPartyType;
  partyId!: string | null;
  partyLabel!: string;
  amountKobo!: number;
  payoutStatus!: PayoutStatus;
  paidAt!: Date | null;
  paidByAdminId!: string | null;
  paidByAdminEmail!: string | null;
  createdAt!: Date;

  static fromRow(
    row: AdminRevenueSplitEntryRow,
  ): AdminRevenueSplitEntryResponseDto {
    const dto = new AdminRevenueSplitEntryResponseDto();
    dto.id = row.id;
    dto.orderId = row.orderId;
    dto.orderTrackingCode = row.orderTrackingCode;
    dto.partyType = row.partyType;
    dto.partyId = row.partyId;
    dto.partyLabel = row.partyLabel;
    dto.amountKobo = row.amountKobo;
    dto.payoutStatus = row.payoutStatus;
    dto.paidAt = row.paidAt;
    dto.paidByAdminId = row.paidByAdminId;
    dto.paidByAdminEmail = row.paidByAdminEmail;
    dto.createdAt = row.createdAt;
    return dto;
  }
}
