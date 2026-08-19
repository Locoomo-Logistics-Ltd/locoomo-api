export interface RevenueSplitRuleRow {
  id: string;
  riderPercent: number;
  nodePercent: number;
  platformPercent: number;
  effectiveFrom: Date;
  createdByAdminId: string;
  createdByAdminEmail: string;
  createdAt: Date;
}

export class RevenueSplitRuleResponseDto {
  id!: string;
  riderPercent!: number;
  nodePercent!: number;
  platformPercent!: number;
  effectiveFrom!: Date;
  createdByAdminId!: string;
  createdByAdminEmail!: string;

  static fromRow(row: RevenueSplitRuleRow): RevenueSplitRuleResponseDto {
    const dto = new RevenueSplitRuleResponseDto();
    dto.id = row.id;
    dto.riderPercent = row.riderPercent;
    dto.nodePercent = row.nodePercent;
    dto.platformPercent = row.platformPercent;
    dto.effectiveFrom = row.effectiveFrom;
    dto.createdByAdminId = row.createdByAdminId;
    dto.createdByAdminEmail = row.createdByAdminEmail;
    return dto;
  }
}
