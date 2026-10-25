import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination-query.dto';
import { ParcelSize } from '../../../../common/parcel-size.enum';

const LEG_STATUSES = [
  'requested',
  'assigned',
  'picked_up',
  'delivered',
  'returning',
  'returned',
  'cancelled',
];

// Omitted = unchanged. For the nullable settings, null clears them (no
// limit / no timeout / no pilot restriction / no cap / no alert).
export class UpdateLogisticsProviderDto {
  @ValidateIf((dto: UpdateLogisticsProviderDto) => dto.enabled !== undefined)
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf((dto: UpdateLogisticsProviderDto) => dto.priority !== undefined)
  @IsInt()
  @Min(1)
  @Max(10000)
  priority?: number;

  @ValidateIf(
    (dto: UpdateLogisticsProviderDto) => dto.maxAttempts !== undefined,
  )
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  assignTimeoutMinutes?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minDistanceKm?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDistanceKm?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  pilotNodeIds?: string[] | null;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(2)
  maxCostShare?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  lowBalanceAlertNaira?: number | null;
}

const PARCEL_SIZES = Object.values(ParcelSize);

export class UpdateVehicleRuleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  rank?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(PARCEL_SIZES, { each: true })
  parcelSizes?: ParcelSize[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  maxWeightKg?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxLongestSideCm?: number;
}

export class ListDeliveriesQueryDto extends PaginationQueryDto {
  // Every courier attempt for one order — by id, or by tracking code (read
  // as forgivingly as the Node app's scan: case, spaces, missing LCM).
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  trackingCode?: string;

  @IsOptional()
  @IsIn(LEG_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  // In progress but nothing heard for 30+ minutes.
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  stuck?: boolean;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class RefreshRoutesDto {
  // Also measure between Nodes still awaiting approval (pilot prep).
  @IsOptional()
  @IsBoolean()
  includePending?: boolean;
}

export class RouteDistancesQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includePending?: boolean;
}

export class EconomicsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
