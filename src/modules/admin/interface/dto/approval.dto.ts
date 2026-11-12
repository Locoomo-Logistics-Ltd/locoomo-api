import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import { ApprovalStatus } from '../../domain/approval-status.enum';
import { ApprovalRequestEntity } from '../../infrastructure/entities/approval-request.entity';

export class ListApprovalsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;
}

export class ApprovalDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ApprovalRejectionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

export class ApprovalResponseDto {
  id!: string;
  action!: string;
  status!: ApprovalStatus;
  summary!: string;
  reason!: string;
  payload!: Record<string, unknown>;
  merchantId!: string | null;
  requestedByUserId!: string;
  decidedByUserId!: string | null;
  decisionNote!: string | null;
  decidedAt!: string | null;
  result!: Record<string, unknown> | null;
  expiresAt!: string;
  createdAt!: string;

  static from(entity: ApprovalRequestEntity): ApprovalResponseDto {
    return {
      id: entity.id,
      action: entity.action,
      status: entity.status,
      summary: entity.summary,
      reason: entity.reason,
      payload: entity.payload,
      merchantId: entity.merchantId,
      requestedByUserId: entity.requestedByUserId,
      decidedByUserId: entity.decidedByUserId,
      decisionNote: entity.decisionNote,
      decidedAt: entity.decidedAt?.toISOString() ?? null,
      result: entity.result,
      expiresAt: entity.expiresAt.toISOString(),
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
