import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidationOptions,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import { ParcelDetailsDto } from '../../../../common/parcel/parcel-details.dto';
import { ParcelSize } from '../../../../common/parcel-size.enum';

const PARCEL_SIZES = Object.values(ParcelSize);

function isLatLng(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const parts = value.split(',');
  if (parts.length !== 2) {
    return false;
  }
  const [lat, lng] = parts.map((part) => Number(part.trim()));
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

const IsLatLng = (options?: ValidationOptions): PropertyDecorator =>
  ValidateBy(
    {
      name: 'isLatLng',
      validator: {
        validate: isLatLng,
        defaultMessage: () =>
          'near must be "latitude,longitude", e.g. 6.5244,3.3792',
      },
    },
    options,
  );

export class ListNodesQueryDto extends CursorQueryDto {
  /** Sort by distance from this point: `latitude,longitude`. */
  @IsOptional()
  @IsLatLng()
  near?: string;

  /** With `near`: search radius in km (default 10, max 50). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  radiusKm: number = 10;

  /** Search name, address and area. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  /** Only Nodes that can accept this parcel size now. */
  @IsOptional()
  @IsIn(PARCEL_SIZES)
  parcelSize?: ParcelSize;
}

export class QuoteQueryDto extends ParcelDetailsDto {
  @IsUUID()
  destinationNodeId!: string;

  /** Where you'll drop the parcel. Required until a hub is assigned to your account. */
  @IsOptional()
  @IsUUID()
  originNodeId?: string;
}

export interface OpeningIntervalView {
  // Local time (Africa/Lagos), HH:mm.
  open: string;
  close: string;
}

export class MerchantNodeView {
  id!: string;
  name!: string;
  address!: string;
  city!: string;
  state!: string;
  latitude!: number;
  longitude!: number;
  /** Distance from `near`, when given. */
  distanceKm!: number | null;
  /** Weekly hours by day (`mon` … `sun`); a missing or empty day is closed. */
  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: {
      type: 'array',
      items: {
        type: 'object',
        required: ['open', 'close'],
        properties: {
          open: { type: 'string', example: '08:00' },
          close: { type: 'string', example: '20:00' },
        },
      },
    },
    description:
      'Local time (Africa/Lagos), HH:mm, by day (mon … sun). A missing or empty day is closed.',
  })
  openingHours!: Record<string, OpeningIntervalView[]> | null;
  contactPhone!: string | null;
  /** False while the Node is full. Parcels already routed there still arrive. */
  acceptingParcels!: boolean;
}

export class MerchantNodeListView {
  @ApiProperty({ type: [MerchantNodeView] })
  items!: MerchantNodeView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class QuoteBreakdownView {
  baseKobo!: number;
  distanceKobo!: number;
  /** Negative or 0. */
  volumeDiscountKobo!: number;
  /** VAT included in `amountKobo` (not added on top). */
  vatKobo!: number;
}

export class QuoteView {
  currency!: 'NGN';
  /** Null for publishable keys with "hide prices". */
  amountKobo!: number | null;
  @ApiProperty({ type: QuoteBreakdownView, nullable: true })
  breakdown!: QuoteBreakdownView | null;
  vehicleClass!: string;
  /** From drop-off to ready for collection. An estimate, not a promise. */
  estimatedReadyInWorkingDays!: number;
}
