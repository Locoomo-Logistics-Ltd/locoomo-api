import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import { MAX_IMPORT_ROWS } from '../../domain/shipment-import';

export class ImportItemsDto {
  /** 1–10,000 shipments, same shape as `POST /shipments`. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_ROWS)
  @IsObject({ each: true })
  items!: Record<string, unknown>[];
}

export class ImportRowsQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(['pending', 'created', 'failed'])
  status?: 'pending' | 'created' | 'failed';
}

export class ShipmentImportView {
  id!: string;
  mode!: 'test' | 'live';
  @ApiProperty({ enum: ['json', 'csv'] })
  source!: 'json' | 'csv';
  @ApiProperty({ enum: ['queued', 'processing', 'done', 'failed'] })
  status!: 'queued' | 'processing' | 'done' | 'failed';
  fileName!: string | null;
  totalRows!: number;
  created!: number;
  failed!: number;
  pending!: number;
  /** Why the whole import stopped, when it did. */
  failureReason!: string | null;
  createdAt!: string;
  completedAt!: string | null;
}

export class ShipmentImportListView {
  @ApiProperty({ type: [ShipmentImportView] })
  items!: ShipmentImportView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class ShipmentImportRowView {
  index!: number;
  /** CSV line (1 = header); null for JSON imports. */
  line!: number | null;
  @ApiProperty({ enum: ['pending', 'created', 'failed'] })
  status!: 'pending' | 'created' | 'failed';
  reference!: string | null;
  shipmentId!: string | null;
  error!: { code: string; message: string; details?: unknown } | null;
}

export class ShipmentImportRowListView {
  @ApiProperty({ type: [ShipmentImportRowView] })
  items!: ShipmentImportRowView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}
