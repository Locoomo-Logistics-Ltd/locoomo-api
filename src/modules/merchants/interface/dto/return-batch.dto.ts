import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { CursorQueryDto } from '../../../../common/pagination/cursor-query.dto';
import { MAX_RETURN_BATCH_SIZE } from '../../domain/return-batch';
import type { ReturnBatchStatus } from '../../domain/return-batch';

export class ListReturnsQueryDto extends CursorQueryDto {
  /** `ready` (waiting at the Node, default) or `incoming` (on the way back). */
  @IsOptional()
  @IsIn(['ready', 'incoming'])
  state: 'ready' | 'incoming' = 'ready';

  @IsOptional()
  @IsUUID()
  nodeId?: string;
}

export class CreateReturnBatchDto {
  /** The Node the returns are waiting at. */
  @IsUUID()
  nodeId!: string;

  /** 1–200 shipments, all `return_ready` at that Node. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_BATCH_SIZE)
  @IsUUID('all', { each: true })
  shipmentIds!: string[];
}

export class ListReturnBatchesQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(['open', 'collected', 'cancelled'])
  status?: ReturnBatchStatus;
}

export class CollectReturnBatchDto {
  @IsString()
  @Length(6, 6)
  code!: string;

  /** Staff checked the collector's ID against the merchant's name. */
  @IsBoolean()
  identityConfirmed!: boolean;

  /** Who took the parcels, as written on their ID. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  collectorName?: string;
}

export class ReturnNodeView {
  id!: string;
  name!: string;
  address!: string;
  city!: string;
}

export class ReturnItemView {
  shipmentId!: string;
  reference!: string;
  trackingCode!: string;
  status!: string;
  returnReason!: string | null;
  readyForCollectionAt!: string | null;
  node!: ReturnNodeView;
  @ApiProperty({ nullable: true, type: Object })
  returnBatch!: { id: string; reference: string } | null;
}

export class ReturnItemListView {
  @ApiProperty({ type: [ReturnItemView] })
  items!: ReturnItemView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}

export class ReturnBatchShipmentView {
  id!: string;
  reference!: string;
  trackingCode!: string;
  status!: string;
  collectedAt!: string | null;
}

export class ReturnBatchView {
  id!: string;
  /** Public; Node staff look the batch up by it. */
  reference!: string;
  @ApiProperty({ enum: ['open', 'collected', 'cancelled'] })
  status!: ReturnBatchStatus;
  node!: ReturnNodeView;
  /** The 6-digit collection code, while open. */
  code!: string | null;
  codeExpiresAt!: string | null;
  shipmentCount!: number;
  /** On GET /return-batches/{id} and after create. */
  @ApiProperty({ type: [ReturnBatchShipmentView], required: false })
  shipments?: ReturnBatchShipmentView[];
  collectedAt!: string | null;
  collectorName!: string | null;
  createdAt!: string;
}

export class ReturnBatchListView {
  @ApiProperty({ type: [ReturnBatchView] })
  items!: ReturnBatchView[];
  nextCursor!: string | null;
  hasMore!: boolean;
}
