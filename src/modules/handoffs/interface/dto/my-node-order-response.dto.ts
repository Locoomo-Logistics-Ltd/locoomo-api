import { ParcelSize } from '../../../../common/parcel-size.enum';

// Deliberately no receiver PII — same reasoning as OrderPreviewResponseDto:
// a general history view doesn't need it, only the actual collection step
// does. myRole tells the operator which side of this order their own Node
// played (a Node can be both an origin for some orders and a destination
// for others), since a single joined Node name/address wouldn't say which.
export interface MyNodeOrderRow {
  id: string;
  trackingCode: string;
  status: string;
  originNodeId: string;
  originNodeName: string;
  destinationNodeId: string;
  destinationNodeName: string;
  parcelDescription: string;
  parcelSize: ParcelSize;
  createdAt: Date;
  myRole: 'origin' | 'destination';
}

export class MyNodeOrderResponseDto {
  id!: string;
  trackingCode!: string;
  status!: string;
  originNodeId!: string;
  originNodeName!: string;
  destinationNodeId!: string;
  destinationNodeName!: string;
  parcelDescription!: string;
  parcelSize!: ParcelSize;
  createdAt!: Date;
  myRole!: 'origin' | 'destination';

  static fromRow(row: MyNodeOrderRow): MyNodeOrderResponseDto {
    const dto = new MyNodeOrderResponseDto();
    dto.id = row.id;
    dto.trackingCode = row.trackingCode;
    dto.status = row.status;
    dto.originNodeId = row.originNodeId;
    dto.originNodeName = row.originNodeName;
    dto.destinationNodeId = row.destinationNodeId;
    dto.destinationNodeName = row.destinationNodeName;
    dto.parcelDescription = row.parcelDescription;
    dto.parcelSize = row.parcelSize;
    dto.createdAt = row.createdAt;
    dto.myRole = row.myRole;
    return dto;
  }
}
