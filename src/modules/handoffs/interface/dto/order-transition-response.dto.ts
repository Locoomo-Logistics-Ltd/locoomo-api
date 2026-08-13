import { OrderTransitionResult } from '../../domain/order-transition-result';

// Confirmation of the transition itself, not the full order view (receiver
// details etc.) — shared by every handoff confirm endpoint (accept,
// drop-off, and the pickup/arrival/collection steps still to come), rather
// than one near-identical DTO per step.
export class OrderTransitionResponseDto {
  id!: string;
  trackingCode!: string;
  status!: string;
  originNodeId!: string;
  destinationNodeId!: string;

  static fromResult(order: OrderTransitionResult): OrderTransitionResponseDto {
    const dto = new OrderTransitionResponseDto();
    dto.id = order.id;
    dto.trackingCode = order.trackingCode;
    dto.status = order.status;
    dto.originNodeId = order.originNodeId;
    dto.destinationNodeId = order.destinationNodeId;
    return dto;
  }
}
