import { ParcelSize } from '../../../../common/parcel-size.enum';
import type { DeliveryView } from '../../../logistics/application/delivery-query.service';
import {
  LabelInstructions,
  labelInstructionsFor,
} from '../../../tracking/application/label-instructions';
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
  // Public tracking page link for the sender to share with the receiver
  // (WhatsApp/SMS) — carries the signed token, so treat it like the order
  // itself.
  trackingUrl!: string;
  // What to write on the parcel before drop-off (Nodes have no printers).
  labelInstructions!: LabelInstructions;
  // Who's carrying it — current (or latest) courier leg, null before
  // drop-off. Never includes the courier's phone for a Consumer.
  delivery!: DeliveryView | null;

  static fromRow(
    order: OrderWithNodeNames,
    trackingUrl: string,
    delivery: DeliveryView | null,
  ): OrderResponseDto {
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
    dto.trackingUrl = trackingUrl;
    dto.delivery = delivery;
    dto.labelInstructions = labelInstructionsFor(
      order.trackingCode,
      order.destinationNodeName,
    );
    return dto;
  }
}
