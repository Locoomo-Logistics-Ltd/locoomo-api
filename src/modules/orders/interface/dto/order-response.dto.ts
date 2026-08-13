import { ParcelSize } from '../../../../common/parcel-size.enum';
import { OrderWithNodeNames } from '../../application/order-query.service';
import { OrderStatus } from '../../domain/order-status.enum';

export class OrderResponseDto {
  id!: string;
  trackingCode!: string;
  paymentIntentId!: string;
  originNodeId!: string;
  originNodeName!: string;
  originNodeAddress!: string;
  destinationNodeId!: string;
  destinationNodeName!: string;
  destinationNodeAddress!: string;
  receiverFullName!: string;
  receiverEmail!: string;
  receiverPhone!: string;
  parcelDescription!: string;
  parcelSize!: ParcelSize;
  amountKobo!: number;
  status!: OrderStatus;
  createdAt!: Date;

  static fromRow(order: OrderWithNodeNames): OrderResponseDto {
    const dto = new OrderResponseDto();
    dto.id = order.id;
    dto.trackingCode = order.trackingCode;
    dto.paymentIntentId = order.paymentIntentId;
    dto.originNodeId = order.originNodeId;
    dto.originNodeName = order.originNodeName;
    dto.originNodeAddress = order.originNodeAddress;
    dto.destinationNodeId = order.destinationNodeId;
    dto.destinationNodeName = order.destinationNodeName;
    dto.destinationNodeAddress = order.destinationNodeAddress;
    dto.receiverFullName = order.receiverFullName;
    dto.receiverEmail = order.receiverEmail;
    dto.receiverPhone = order.receiverPhone;
    dto.parcelDescription = order.parcelDescription;
    dto.parcelSize = order.parcelSize;
    dto.amountKobo = order.amountKobo;
    dto.status = order.status;
    dto.createdAt = order.createdAt;
    return dto;
  }
}
