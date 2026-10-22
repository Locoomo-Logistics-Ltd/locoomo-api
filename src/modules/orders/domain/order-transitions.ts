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
  [OrderStatus.IN_TRANSIT]: [OrderStatus.ARRIVED_AT_DESTINATION],
  [OrderStatus.ARRIVED_AT_DESTINATION]: [OrderStatus.READY_FOR_COLLECTION],
  [OrderStatus.READY_FOR_COLLECTION]: [OrderStatus.COMPLETED],
};

export function assertLegalTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  if (!ORDER_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Illegal order transition requested: ${from} -> ${to}`);
  }
}
