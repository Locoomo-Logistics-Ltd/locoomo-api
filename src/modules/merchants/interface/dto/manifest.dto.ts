import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import { MeasuredParcelDto } from '../../../handoffs/interface/dto/confirm-drop-off.dto';
import { MAX_MANIFEST_ADD } from '../../domain/manifest';
import type { ManifestStatus } from '../../domain/manifest';

const STATUSES: ManifestStatus[] = ['open', 'closed', 'received', 'cancelled'];

export class CreateManifestDto {
  /** Defaults to your assigned hub. */
  @IsOptional()
  @IsUUID()
  hubNodeId?: string;

  /** When the truck should arrive (informational). */
  @IsOptional()
  @IsDateString()
  expectedDropAt?: string;

  /** Up to 1,000 shipments now; add more later. Each must be `created`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MANIFEST_ADD)
  @IsUUID('all', { each: true })
  shipmentIds?: string[];
}

export class AddManifestShipmentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MANIFEST_ADD)
  @IsUUID('all', { each: true })
  shipmentIds!: string[];
}

export class ListManifestsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: ManifestStatus;
}

export class SimulateManifestReceiptDto {
  /** Leave these out of the truck, to see `missing`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MANIFEST_ADD)
  @IsUUID('all', { each: true })
  missingShipmentIds?: string[];
}

export class HubScanDto {
  /** Our tracking code, your reference or your own barcode. */
  @IsString()
  @Length(1, 120)
  code!: string;

  /** The manifest being checked in (MF-…), if any. */
  @IsOptional()
  @IsString()
  @Length(4, 20)
  manifestReference?: string;

  /** Which of your Nodes is scanning, when you work at several. */
  @IsOptional()
  @IsUUID()
  nodeId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MeasuredParcelDto)
  measured?: MeasuredParcelDto;
}

export class ManifestHubView {
  id!: string;
  name!: string;
  address!: string;
  city!: string;
}

export class ManifestView {
  id!: string;
  /** MF-XXXX-XXXX, printed on the manifest; the hub scans it. */
  reference!: string;
  @ApiProperty({ enum: STATUSES })
  status!: ManifestStatus;
  hub!: ManifestHubView;
  expectedDropAt!: string | null;
  shipmentCount!: number;
  receivedCount!: number;
  unexpectedCount!: number;
  /** Once the hub has finished (`received`). */
  missingCount!: number | null;
  closedAt!: string | null;
  receivedAt!: string | null;
  createdAt!: string;
}

export class ManifestListView {
  @ApiProperty({ type: [ManifestView] })
  items!: ManifestView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class ManifestShipmentRef {
  shipmentId!: string;
  reference!: string;
}

export class ManifestReceiptView {
  manifestId!: string;
  reference!: string;
  received!: number;
  @ApiProperty({ type: [ManifestShipmentRef] })
  missing!: ManifestShipmentRef[];
  @ApiProperty({ type: [ManifestShipmentRef] })
  unexpected!: ManifestShipmentRef[];
}
