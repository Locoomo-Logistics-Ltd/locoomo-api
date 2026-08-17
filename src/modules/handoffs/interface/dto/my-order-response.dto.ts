import { ParcelSize } from '../../../../common/parcel-size.enum';

// Deliberately no receiver PII — same reasoning as AvailableOrderResponseDto
// and OrderPreviewResponseDto: a rider doesn't need it, only the
// destination operator does, at collection.
export interface MyOrderRow {
  id: string;
  trackingCode: string;
  status: string;
  originNodeId: string;
  originNodeName: string;
  originNodeAddress: string;
  destinationNodeId: string;
  destinationNodeName: string;
  destinationNodeAddress: string;
  parcelDescription: string;
  parcelSize: ParcelSize;
  createdAt: Date;
}

export class MyOrderResponseDto {
  id!: string;
  trackingCode!: string;
  status!: string;
  originNodeId!: string;
  originNodeName!: string;
  originNodeAddress!: string;
  destinationNodeId!: string;
  destinationNodeName!: string;
  destinationNodeAddress!: string;
  parcelDescription!: string;
  parcelSize!: ParcelSize;
  createdAt!: Date;

  static fromRow(row: MyOrderRow): MyOrderResponseDto {
    const dto = new MyOrderResponseDto();
    dto.id = row.id;
    dto.trackingCode = row.trackingCode;
    dto.status = row.status;
    dto.originNodeId = row.originNodeId;
    dto.originNodeName = row.originNodeName;
    dto.originNodeAddress = row.originNodeAddress;
    dto.destinationNodeId = row.destinationNodeId;
    dto.destinationNodeName = row.destinationNodeName;
    dto.destinationNodeAddress = row.destinationNodeAddress;
    dto.parcelDescription = row.parcelDescription;
    dto.parcelSize = row.parcelSize;
    dto.createdAt = row.createdAt;
    return dto;
  }
}
