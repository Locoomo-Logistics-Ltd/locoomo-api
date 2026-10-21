import { ParcelSize } from '../../../../common/parcel-size.enum';
import {
  maskReceiver,
  NextAction,
  nextActionFor,
  NodeRole,
  nodeRoleFor,
} from '../../domain/counter-view';

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
  shelfNodeId: string | null;
  shelfNumber: number | null;
  receiverFullName: string;
  receiverPhone: string;
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
  myRole!: NodeRole;
  nextAction!: NextAction;
  shelfNumber!: number | null;
  receiverMasked!: string;

  static fromRow(
    row: MyNodeOrderRow,
    myNodeIds: readonly string[],
  ): MyNodeOrderResponseDto {
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
    dto.myRole = nodeRoleFor(row, myNodeIds);
    dto.nextAction = nextActionFor(row.status, dto.myRole);
    dto.shelfNumber =
      row.shelfNodeId && myNodeIds.includes(row.shelfNodeId)
        ? row.shelfNumber
        : null;
    dto.receiverMasked = maskReceiver(row.receiverFullName, row.receiverPhone);
    return dto;
  }
}
