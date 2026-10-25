import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ParcelSize } from '../parcel-size.enum';

export const HANDLING_FLAGS = [
  'fragile',
  'keep_upright',
  'perishable',
  'liquid',
] as const;
export type HandlingFlag = (typeof HANDLING_FLAGS)[number];

const PARCEL_SIZES = Object.values(ParcelSize);

const anyDimension = (dto: ParcelDetailsDto) =>
  dto.lengthCm !== undefined ||
  dto.widthCm !== undefined ||
  dto.heightCm !== undefined;

// What a parcel is, as far as moving it goes (decision 5) — shared by
// checkout, a Node's own dispatch, and the price preview, so all three
// validate it identically. Weight and dimensions are optional for now;
// when given they decide the vehicle (and so the price) alongside
// parcelSize. Upper bounds are sanity limits only — whether a parcel can be
// carried at all is the vehicle rules' call (422 NO_DELIVERY_OPTION).
export abstract class ParcelDetailsDto {
  @IsIn(PARCEL_SIZES, {
    message: `parcelSize must be one of: ${PARCEL_SIZES.join(', ')}`,
  })
  parcelSize!: ParcelSize;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(1000)
  weightKg?: number;

  // All three or none.
  @ValidateIf(anyDimension)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  lengthCm?: number;

  @ValidateIf(anyDimension)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  widthCm?: number;

  @ValidateIf(anyDimension)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  heightCm?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(HANDLING_FLAGS.length)
  @IsIn(HANDLING_FLAGS, {
    each: true,
    message: `handling values must be from: ${HANDLING_FLAGS.join(', ')}`,
  })
  handling?: HandlingFlag[];
}

// The same details as plain data, for passing between modules.
export interface ParcelDetails {
  parcelSize: ParcelSize;
  weightKg?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  handling?: readonly string[];
}
