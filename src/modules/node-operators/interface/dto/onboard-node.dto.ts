import { Type } from 'class-transformer';
import {
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

  @IsOptional()
  @IsString()
  @MaxLength(255)
  operatingHours?: string;
}
