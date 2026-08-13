import { ParcelSize } from '../../../../common/parcel-size.enum';

// What a Node operator sees before confirming drop-off — parcel details to
// physically match against what's in front of them, plus where it's headed
// next. No receiver PII here either (same reasoning as
// AvailableOrderResponseDto): the origin operator doesn't need it, only the
// destination operator does, at collection.
export interface OrderPreviewRow {
  id: string;
  trackingCode: string;
  status: string;
  originNodeId: string;
  destinationNodeId: string;
  destinationNodeName: string;
  parcelDescription: string;
  parcelSize: ParcelSize;
  createdAt: Date;
}

export class OrderPreviewResponseDto {
  id!: string;
  trackingCode!: string;
  status!: string;
  originNodeId!: string;
  destinationNodeId!: string;
  destinationNodeName!: string;
  parcelDescription!: string;
  parcelSize!: ParcelSize;
  createdAt!: Date;

  static fromRow(row: OrderPreviewRow): OrderPreviewResponseDto {
    const dto = new OrderPreviewResponseDto();
    dto.id = row.id;
    dto.trackingCode = row.trackingCode;
    dto.status = row.status;
    dto.originNodeId = row.originNodeId;
    dto.destinationNodeId = row.destinationNodeId;
    dto.destinationNodeName = row.destinationNodeName;
    dto.parcelDescription = row.parcelDescription;
    dto.parcelSize = row.parcelSize;
    dto.createdAt = row.createdAt;
    return dto;
  }
}
