import { ParcelSize } from '../../../../common/parcel-size.enum';
import type { DeliveryView } from '../../../logistics/application/delivery-query.service';
import {
  maskReceiver,
  NextAction,
  nextActionFor,
  NodeRole,
  nodeRoleFor,
} from '../../domain/counter-view';

export interface OrderPreviewRow {
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

// What the Node app shows after a scan. Never the receiver's full name or
// phone — `receiverMasked` is enough to match a parcel to the person at the
// counter; full details are only relevant at collection.
export class OrderPreviewResponseDto {
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
  // Shelf number at *the caller's* Node — null when the parcel isn't on one
  // of their shelves.
  shelfNumber!: number | null;
  receiverMasked!: string;
  // The current (or latest) courier leg — null before drop-off.
  delivery!: DeliveryView | null;

  static fromRow(
    row: OrderPreviewRow,
    myNodeIds: readonly string[],
    delivery: DeliveryView | null,
  ): OrderPreviewResponseDto {
    const dto = new OrderPreviewResponseDto();
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
    dto.nextAction = nextActionFor(row.status, dto.myRole, delivery?.handover);
    dto.shelfNumber =
      row.shelfNodeId && myNodeIds.includes(row.shelfNodeId)
        ? row.shelfNumber
        : null;
    dto.receiverMasked = maskReceiver(row.receiverFullName, row.receiverPhone);
    dto.delivery = delivery;
    return dto;
  }
}
