import { NodeResponseDto } from '../../../nodes/interface/dto/node-response.dto';
import { NodeOperatorProfileRow } from '../../application/node-operator-query.service';

// `node` typed via NodeResponseDto.fromEntity's own parameter type rather
// than importing NodeEntity directly — NodeEntity lives in nodes'
// infrastructure/ layer, which the module-boundary rule forbids importing
// cross-module. This keeps full type-safety without that import.
type NodeEntityLike = Parameters<typeof NodeResponseDto.fromEntity>[0];

export interface PayoutAccountFields {
  payoutBankCode: string | null;
  payoutBankName: string | null;
  payoutAccountNumber: string | null;
  payoutAccountName: string | null;
  payoutAccountVerifiedAt: Date | null;
}

const NO_PAYOUT_ACCOUNT: PayoutAccountFields = {
  payoutBankCode: null,
  payoutBankName: null,
  payoutAccountNumber: null,
  payoutAccountName: null,
  payoutAccountVerifiedAt: null,
};

export class NodeOperatorResponseDto {
  profileId!: string;
  // 'owner' or 'staff' (Phase 2) — which relationship the caller has to
  // this specific Node, so the frontend can show "you own this" vs.
  // "you're staff here" and hide owner-only actions accordingly.
  roleAtNode!: string;
  node!: NodeResponseDto;
  // Own-view payout account fields — shown in full, same reasoning as
  // RiderResponseDto's. payoutAccountConfigured is the dashboard-prompt
  // signal.
  payoutAccountConfigured!: boolean;
  payoutBankCode!: string | null;
  payoutBankName!: string | null;
  payoutAccountNumber!: string | null;
  payoutAccountName!: string | null;

  // payout defaults to "not configured" — the onboarding/approval flows
  // that also call this never have payout details yet at that point.
  static fromEntity(
    profileId: string,
    roleAtNode: string,
    node: NodeEntityLike,
    payout: PayoutAccountFields = NO_PAYOUT_ACCOUNT,
  ): NodeOperatorResponseDto {
    const dto = new NodeOperatorResponseDto();
    dto.profileId = profileId;
    dto.roleAtNode = roleAtNode;
    dto.node = NodeResponseDto.fromEntity(node);
    dto.payoutAccountConfigured = payout.payoutAccountVerifiedAt !== null;
    dto.payoutBankCode = payout.payoutBankCode;
    dto.payoutBankName = payout.payoutBankName;
    dto.payoutAccountNumber = payout.payoutAccountNumber;
    dto.payoutAccountName = payout.payoutAccountName;
    return dto;
  }

  static fromRow(row: NodeOperatorProfileRow): NodeOperatorResponseDto {
    return NodeOperatorResponseDto.fromEntity(
      row.profileId,
      row.roleAtNode,
      row as unknown as NodeEntityLike,
      row,
    );
  }
}
