import { Type } from 'class-transformer';
import {
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

  @IsOptional()
  @IsString()
  @MaxLength(255)
  operatingHours?: string;

  @IsOptional()
  @IsIn(ADMIN_CREATABLE_ONBOARDING_TYPES, {
    message: `onboardingType must be one of: ${ADMIN_CREATABLE_ONBOARDING_TYPES.join(', ')}`,
  })
  onboardingType?: NodeOnboardingType;
}
