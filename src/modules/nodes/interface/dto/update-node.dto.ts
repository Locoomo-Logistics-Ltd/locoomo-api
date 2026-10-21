import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsOpeningHours } from '../../../../common/opening-hours/opening-hours';
import type { OpeningHours } from '../../../../common/opening-hours/opening-hours';
import {
  IsPhoneE164,
  NormalizePhone,
} from '../../../../common/phone/phone-number';
import { NodeStatus } from '../../domain/node-status.enum';

// onboardingType is immutable after creation — not included here.
export class UpdateNodeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity?: number;

  // Legacy free-text hours — use openingHours.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  operatingHours?: string;

  @IsOptional()
  @NormalizePhone()
  @IsPhoneE164()
  contactPhone?: string;

  @IsOptional()
  @IsOpeningHours()
  openingHours?: OpeningHours;

  @IsOptional()
  @IsEnum(NodeStatus)
  status?: NodeStatus;

  // Admin-only escape hatch: keep the given pin even if it disagrees with
  // where the address geocodes to (new estates and informal addresses Google
  // doesn't know). Recorded as locationCheck "admin_override".
  @IsOptional()
  @IsBoolean()
  forceLocation?: boolean;
}
