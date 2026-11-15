import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ParcelSize } from '../../../../common/parcel-size.enum';

// What the counter measured. Any subset; dimensions all three or none.
export class MeasuredParcelDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(1000)
  weightKg?: number;

  @ValidateIf(
    (m: MeasuredParcelDto) =>
      m.lengthCm !== undefined ||
      m.widthCm !== undefined ||
      m.heightCm !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(1)
  @Max(500)
  lengthCm?: number;

  @ValidateIf(
    (m: MeasuredParcelDto) =>
      m.lengthCm !== undefined ||
      m.widthCm !== undefined ||
      m.heightCm !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(1)
  @Max(500)
  widthCm?: number;

  @ValidateIf(
    (m: MeasuredParcelDto) =>
      m.lengthCm !== undefined ||
      m.widthCm !== undefined ||
      m.heightCm !== undefined,
  )
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(1)
  @Max(500)
  heightCm?: number;

  @IsOptional()
  @IsEnum(ParcelSize)
  size?: ParcelSize;
}

// POST /handoffs/orders/:id/drop-off. Both optional; no body is fine.
export class ConfirmDropOffDto {
  /** Which of your Nodes is receiving it, when a merchant parcel booked for
   * another Node is brought to you and you work at several. */
  @IsOptional()
  @IsUUID()
  nodeId?: string;

  /** What you measured (merchant parcels are re-priced on it). */
  @IsOptional()
  @ValidateNested()
  @Type(() => MeasuredParcelDto)
  measured?: MeasuredParcelDto;
}
