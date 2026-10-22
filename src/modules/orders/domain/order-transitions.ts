import { OrderStatus } from './order-status.enum';

export const ORDER_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.AWAITING_DROP_OFF]: [OrderStatus.PARCEL_RECEIVED_AT_ORIGIN],
  [OrderStatus.PARCEL_RECEIVED_AT_ORIGIN]: [OrderStatus.RIDER_ASSIGNED],
  // Back to waiting when a courier drops the job or it's cancelled before
  // pickup — the parcel never left the origin Node.
  [OrderStatus.RIDER_ASSIGNED]: [
    OrderStatus.IN_TRANSIT,
    OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
  ],
  // Or, if the courier can't complete the delivery, back to origin.
  [OrderStatus.IN_TRANSIT]: [
    OrderStatus.ARRIVED_AT_DESTINATION,
    OrderStatus.RETURN_INITIATED,
  ],
  [OrderStatus.ARRIVED_AT_DESTINATION]: [OrderStatus.READY_FOR_COLLECTION],
  [OrderStatus.READY_FOR_COLLECTION]: [OrderStatus.COMPLETED],
  [OrderStatus.RETURN_INITIATED]: [OrderStatus.RETURN_IN_TRANSIT],
  [OrderStatus.RETURN_IN_TRANSIT]: [OrderStatus.RETURNED_TO_ORIGIN],
  [OrderStatus.RETURNED_TO_ORIGIN]: [OrderStatus.READY_FOR_SENDER_COLLECTION],
  [OrderStatus.READY_FOR_SENDER_COLLECTION]: [OrderStatus.RETURN_COMPLETED],
};

export function assertLegalTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  if (!ORDER_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Illegal order transition requested: ${from} -> ${to}`);
  }
}
