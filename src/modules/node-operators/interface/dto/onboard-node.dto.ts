import { Type } from 'class-transformer';
import {
  IsBoolean,
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

// Same shape as nodes' CreateNodeDto minus `onboardingType` — that's forced
// server-side to `portal` (OnboardNodeService), never client-settable here.
export class OnboardNodeDto {
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

  // Public (default): listed for everyone to send to and collect from.
  // Private (false): only the owner's own dispatches use it, up to
  // PRIVATE_NODE_MONTHLY_ORDER_LIMIT orders a month before ops review it.
  @IsOptional()
  @IsBoolean()
  isPubliclyVisible?: boolean;
}
