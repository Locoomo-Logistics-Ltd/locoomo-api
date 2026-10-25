import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
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
import { NodeOnboardingType } from '../../domain/node-onboarding-type.enum';

const ADMIN_CREATABLE_ONBOARDING_TYPES = [
  NodeOnboardingType.FIELD_RECRUITED,
  NodeOnboardingType.WARM_LEAD,
  NodeOnboardingType.CHAIN_PARTNER,
  NodeOnboardingType.FRANCHISE,
];

export class CreateNodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  address!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  state!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity!: number;

  // Legacy free-text hours — use openingHours.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  operatingHours?: string;

  // Counter phone couriers call — any common Nigerian format is accepted and
  // stored as E.164.
  @NormalizePhone()
  @IsPhoneE164()
  contactPhone!: string;

  @IsOpeningHours()
  openingHours!: OpeningHours;

  @IsOptional()
  @IsIn(ADMIN_CREATABLE_ONBOARDING_TYPES, {
    message: `onboardingType must be one of: ${ADMIN_CREATABLE_ONBOARDING_TYPES.join(', ')}`,
  })
  onboardingType?: NodeOnboardingType;

  // Admin-only escape hatch: keep the given pin even if it disagrees with
  // where the address geocodes to (new estates and informal addresses Google
  // doesn't know). Recorded as locationCheck "admin_override".
  @IsOptional()
  @IsBoolean()
  forceLocation?: boolean;
}
