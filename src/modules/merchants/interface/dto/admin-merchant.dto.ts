import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import {
  MerchantStatus,
  MerchantTier,
  ReviewDecision,
  ReviewItemKey,
} from '../../domain/merchant.enums';

export class ListMerchantsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(MerchantStatus)
  status?: MerchantStatus;

  // Matches trading/legal name, contact email or CAC number.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ReviewItemDecisionDto {
  @IsEnum(ReviewItemKey)
  key!: ReviewItemKey;

  @IsEnum(ReviewDecision)
  decision!: ReviewDecision;

  // Required when rejecting; shown to the merchant.
  @ValidateIf(
    (item: ReviewItemDecisionDto) =>
      item.decision === ReviewDecision.REJECTED || item.reason !== undefined,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

export class ReviewMerchantDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ReviewItemDecisionDto)
  items!: ReviewItemDecisionDto[];
}

// `null` = unlimited; omitted = tier default.
export class MerchantLimitsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  liveShipmentsPerDay?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  maxWalletBalanceKobo?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Max(0)
  negativeBalanceFloorKobo?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  claimCapKobo?: number | null;
}

export class ApproveMerchantDto {
  // Defaults to the merchant's type (individual / business).
  @IsOptional()
  @IsEnum(MerchantTier)
  tier?: MerchantTier;

  @IsOptional()
  @ValidateNested()
  @Type(() => MerchantLimitsDto)
  limits?: MerchantLimitsDto;
}

export class RequestMerchantChangesDto {
  // Optional: per-section decisions to record in the same call.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ReviewItemDecisionDto)
  items?: ReviewItemDecisionDto[];

  // Overall note shown with the email.
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class MerchantReasonDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class UpdateMerchantSettingsDto {
  @IsOptional()
  @IsBoolean()
  receiverCodeRelay?: boolean;

  @IsOptional()
  @IsBoolean()
  creationPaused?: boolean;

  @IsOptional()
  @IsEnum(MerchantTier)
  tier?: MerchantTier;

  // Replaces all overrides; send {} to go back to the tier defaults.
  @IsOptional()
  @ValidateNested()
  @Type(() => MerchantLimitsDto)
  limits?: MerchantLimitsDto;

  // The merchant's hub (an active hub Node), or null to remove it.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  hubNodeId?: string | null;
}
