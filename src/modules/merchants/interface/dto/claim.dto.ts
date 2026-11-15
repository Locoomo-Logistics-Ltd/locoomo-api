import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import {
  CLAIM_TYPES,
  MAX_CLAIM_EVIDENCE,
  MAX_CLAIM_PAYOUT_KOBO,
} from '../../domain/claim';
import type { ClaimStatus, ClaimType } from '../../domain/claim';

const CLAIM_STATUSES: ClaimStatus[] = ['open', 'approved', 'rejected'];

export class FileClaimDto {
  @IsUUID()
  shipmentId!: string;

  /** `lost`, `damaged` or `missing_item`. */
  @IsIn(CLAIM_TYPES)
  type!: ClaimType;

  /** What happened: 10–2000 characters. */
  @IsString()
  @Length(10, 2000)
  description!: string;

  /** Up to 10 upload ids from `POST /claims/uploads` (photos, PDFs). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAIM_EVIDENCE)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  evidence?: string[];
}

export class ListClaimsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(CLAIM_STATUSES)
  status?: ClaimStatus;

  @IsOptional()
  @IsUUID()
  shipmentId?: string;
}

export class DecideTestClaimDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  /** Approve only. Defaults to the most the claim can pay. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CLAIM_PAYOUT_KOBO)
  amountKobo?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class AdminListClaimsQueryDto extends ListClaimsQueryDto {
  @IsOptional()
  @IsUUID()
  merchantId?: string;

  @IsOptional()
  @IsIn(['test', 'live'])
  mode: 'test' | 'live' = 'live';
}

export class ClaimNoteDto {
  @IsString()
  @Length(1, 2000)
  internalNote!: string;
}

export class RejectClaimDto {
  /** Shown to the merchant: why it wasn't approved. */
  @IsString()
  @Length(3, 1000)
  merchantNote!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;
}

export class RequestClaimPayoutDto {
  @IsInt()
  @Min(1)
  @Max(MAX_CLAIM_PAYOUT_KOBO)
  amountKobo!: number;

  /** Shown to the merchant with the approval. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  merchantNote?: string;

  /** For the approving admin. */
  @IsString()
  @Length(3, 1000)
  reason!: string;
}

export class ClaimView {
  id!: string;
  shipmentId!: string;
  reference!: string;
  trackingCode!: string;
  @ApiProperty({ enum: CLAIM_TYPES })
  type!: ClaimType;
  /** `merchant` (you filed it) or `exception` (Locoomo opened it). */
  source!: 'merchant' | 'exception';
  @ApiProperty({ enum: CLAIM_STATUSES })
  status!: ClaimStatus;
  description!: string;
  evidence!: string[];
  declaredValueKobo!: number | null;
  /** The most this claim can pay: the declared value, capped. */
  maxPayoutKobo!: number;
  /** Credited to the wallet, once approved. */
  payoutKobo!: number | null;
  /** Locoomo's note with the decision. */
  decisionNote!: string | null;
  decidedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class ClaimListView {
  @ApiProperty({ type: [ClaimView] })
  items!: ClaimView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}
