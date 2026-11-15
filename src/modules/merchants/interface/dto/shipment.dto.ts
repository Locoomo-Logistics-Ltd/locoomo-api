import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import { HANDLING_FLAGS } from '../../../../common/parcel/parcel-details.dto';
import { ParcelSize } from '../../../../common/parcel-size.enum';
import {
  IsPhoneE164,
  NormalizePhone,
} from '../../../../common/phone/phone-number';
import { NOTIFY_RECEIVER_VALUES, ShipmentStatus } from '../../domain/shipment';
import type { NotifyReceiver } from '../../domain/shipment';

const PARCEL_SIZES = Object.values(ParcelSize);
const STATUSES = Object.values(ShipmentStatus);

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// Up to 50 string keys (≤ 40 chars) with string values (≤ 500 chars),
// 8 KB in total. Echoed back everywhere; never interpreted.
function isMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= 50 &&
    entries.every(
      ([key, v]) =>
        key.length > 0 &&
        key.length <= 40 &&
        typeof v === 'string' &&
        v.length <= 500,
    ) &&
    Buffer.byteLength(JSON.stringify(value)) <= 8_192
  );
}

const IsMetadata = (): PropertyDecorator =>
  ValidateBy({
    name: 'isMetadata',
    validator: {
      validate: isMetadata,
      defaultMessage: () =>
        'metadata must be an object of up to 50 string values (keys ≤ 40 chars, values ≤ 500 chars, 8 KB total)',
    },
  });

export class ShipmentOriginDto {
  /** `hub` (your assigned hub) or `node` (a specific Node). */
  @IsIn(['hub', 'node'])
  type!: 'hub' | 'node';

  /** Required when `type` is `node`. */
  @ValidateIf((origin: ShipmentOriginDto) => origin.type === 'node')
  @IsUUID()
  nodeId?: string;
}

export class ShipmentReceiverDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  /** Any Nigerian format; returned as E.164. */
  @NormalizePhone()
  @IsPhoneE164()
  phone!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class ShipmentReceiverUpdateDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @NormalizePhone()
  @IsPhoneE164()
  phone?: string;

  /** `null` removes the email. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string | null;
}

const anyDimension = (parcel: ShipmentParcelDto): boolean =>
  parcel.lengthCm !== undefined ||
  parcel.widthCm !== undefined ||
  parcel.heightCm !== undefined;

export class ShipmentParcelDto {
  /** Be specific ("Wireless earbuds", not "Item"). */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsIn(PARCEL_SIZES)
  size!: ParcelSize;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(1000)
  weightKg?: number;

  /** Send all three dimensions or none. */
  @ValidateIf(anyDimension)
  @IsInt()
  @Min(1)
  @Max(500)
  lengthCm?: number;

  @ValidateIf(anyDimension)
  @IsInt()
  @Min(1)
  @Max(500)
  widthCm?: number;

  @ValidateIf(anyDimension)
  @IsInt()
  @Min(1)
  @Max(500)
  heightCm?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(HANDLING_FLAGS, { each: true })
  handling?: string[];

  /** Basis for claims (compensation is capped). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000_000)
  declaredValueKobo?: number;
}

export class CreateShipmentDto {
  /** Your id for this parcel, unique per account and mode. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^\P{Cc}+$/u, {
    message: 'reference must not contain control characters',
  })
  reference!: string;

  @IsUUID()
  destinationNodeId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ShipmentOriginDto)
  origin?: ShipmentOriginDto;

  @ValidateNested()
  @Type(() => ShipmentReceiverDto)
  receiver!: ShipmentReceiverDto;

  @ValidateNested()
  @Type(() => ShipmentParcelDto)
  parcel!: ShipmentParcelDto;

  /** A barcode already on the parcel; hub scanners accept it. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  externalBarcode?: string;

  @IsOptional()
  @IsIn(NOTIFY_RECEIVER_VALUES)
  notifyReceiver?: NotifyReceiver;

  @IsOptional()
  @IsMetadata()
  metadata?: Record<string, string>;
}

export class UpdateShipmentDto {
  /** Until collected; the buyer gets a fresh code if already shelved. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ShipmentReceiverUpdateDto)
  receiver?: ShipmentReceiverUpdateDto;

  /** Only while `created`; re-quoted and the hold adjusted. */
  @IsOptional()
  @IsUUID()
  destinationNodeId?: string;

  /** Only while `created`. Send the whole parcel object. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ShipmentParcelDto)
  parcel?: ShipmentParcelDto;

  /** Replaces the metadata. */
  @IsOptional()
  @IsMetadata()
  metadata?: Record<string, string>;
}

export class BulkCreateShipmentsDto {
  /** 1–100 shipments, same shape as `POST /shipments`. Each succeeds or fails on its own. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsObject({ each: true })
  items!: Record<string, unknown>[];
}

export class ListShipmentsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: ShipmentStatus;

  @IsOptional()
  @IsUUID()
  destinationNodeId?: string;

  @IsOptional()
  @IsUUID()
  manifestId?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  /** Changes since this time, oldest change first (for syncing). */
  @IsOptional()
  @IsISO8601()
  updatedSince?: string;
}

export const SIMULATE_TARGETS = [
  ...STATUSES.filter((s) => s !== ShipmentStatus.CREATED),
  'fee_adjusted',
  'destination_changed',
] as const;

export class SimulateShipmentDto {
  /** A status from §8, or `fee_adjusted` / `destination_changed`. */
  @IsIn(SIMULATE_TARGETS)
  to!: (typeof SIMULATE_TARGETS)[number];

  /** With `to: exception`. Default `lost`. */
  @IsOptional()
  @IsIn(['lost', 'damaged'])
  exceptionType?: 'lost' | 'damaged';

  /** With `to: destination_changed`: the new Node (default: another nearby one). */
  @IsOptional()
  @IsUUID()
  destinationNodeId?: string;
}

// ---- Responses (the Shipment object, MERCHANT_API.md §7.4) ----

export class ShipmentNodeView {
  nodeId!: string | null;
  nodeName!: string | null;
}

export class ShipmentOriginView extends ShipmentNodeView {
  type!: 'hub' | 'node';
}

export class ShipmentDestinationView extends ShipmentNodeView {
  address!: string | null;
  city!: string | null;
  state!: string | null;
  /** True if we rerouted to another Node (the buyer was told). */
  changed!: boolean;
}

export class ShipmentReceiverView {
  name!: string;
  /** E.164. */
  phone!: string;
  email!: string | null;
}

export class MeasuredParcelView {
  weightKg!: number | null;
  size!: string;
}

export class ShipmentParcelView {
  description!: string;
  size!: string;
  weightKg!: number | null;
  lengthCm!: number | null;
  widthCm!: number | null;
  heightCm!: number | null;
  handling!: string[];
  declaredValueKobo!: number | null;
  @ApiProperty({ type: MeasuredParcelView, nullable: true })
  measured!: MeasuredParcelView | null;
}

export class ShipmentFeeBreakdownView {
  baseKobo!: number;
  distanceKobo!: number;
  volumeDiscountKobo!: number;
  /** VAT included in the fee. */
  vatKobo!: number;
}

export class ShipmentFeeView {
  currency!: 'NGN';
  quotedKobo!: number;
  chargedKobo!: number | null;
  /** `held` → `charged` (received), or `released` (ended before drop-off). */
  state!: 'held' | 'charged' | 'released';
  breakdown!: ShipmentFeeBreakdownView;
}

export class ShipmentCollectionView {
  /** End of the 7-working-day window, once on the shelf. */
  deadline!: string | null;
  collectedAt!: string | null;
  method!: 'code' | 'id_check' | null;
  collectorName!: string | null;
}

export class ShipmentReturnView {
  reason!: 'not_collected' | 'delivery_failed' | 'merchant_request';
  readyForCollectionAt!: string | null;
}

export class ShipmentExceptionView {
  type!: 'lost' | 'damaged';
  reportedAt!: string;
  claimId!: string | null;
}

export class ShipmentView {
  id!: string;
  mode!: 'test' | 'live';
  reference!: string;
  /** `LCM-…` live, `LCT-…` test. */
  trackingCode!: string;
  /** Public tracking page (null in test mode). */
  trackingUrl!: string | null;
  status!: ShipmentStatus;
  /** Increases on every change; drop older webhooks. */
  sequence!: number;
  statusChangedAt!: string;
  origin!: ShipmentOriginView;
  destination!: ShipmentDestinationView;
  receiver!: ShipmentReceiverView;
  parcel!: ShipmentParcelView;
  externalBarcode!: string | null;
  manifestId!: string | null;
  fee!: ShipmentFeeView;
  /** Drop off by this time or the shipment expires. */
  dropDeadline!: string;
  collection!: ShipmentCollectionView;
  @ApiProperty({ type: ShipmentReturnView, nullable: true })
  return!: ShipmentReturnView | null;
  @ApiProperty({ type: ShipmentExceptionView, nullable: true })
  exception!: ShipmentExceptionView | null;
  notifyReceiver!: NotifyReceiver;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  metadata!: Record<string, string>;
  createdAt!: string;
  updatedAt!: string;
}

export class ShipmentListView {
  @ApiProperty({ type: [ShipmentView] })
  items!: ShipmentView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class TimelineEntryView {
  type!: string;
  at!: string;
  nodeName!: string | null;
  sequence!: number;
  /** Event details, as in the webhook's `data` extras: `reason`,
   * `adjustment`, `previousOrigin`, `changed`, … (never collection codes). */
  data!: Record<string, unknown> | null;
}

export class BulkResultError {
  code!: string;
  message!: string;
  details?: unknown;
}

export class BulkResultView {
  index!: number;
  ok!: boolean;
  shipment?: ShipmentView;
  error?: BulkResultError;
}

export class BulkCreateResultView {
  @ApiProperty({ type: [BulkResultView] })
  results!: BulkResultView[];
}
