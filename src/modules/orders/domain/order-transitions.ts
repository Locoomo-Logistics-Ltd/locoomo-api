import { OrderStatus } from './order-status.enum';

// While the parcel is in our custody, an admin can record it lost or
// damaged (plan §5.3).
const X = OrderStatus.EXCEPTION;

export const ORDER_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  // Refused at the counter, or cancelled before anyone dropped it off.
  [OrderStatus.AWAITING_DROP_OFF]: [
    OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
    OrderStatus.REFUSED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PARCEL_RECEIVED_AT_ORIGIN]: [OrderStatus.RIDER_ASSIGNED, X],
  // Back to waiting when a courier drops the job or it's cancelled before
  // pickup — the parcel never left the origin Node.
  [OrderStatus.RIDER_ASSIGNED]: [
    OrderStatus.IN_TRANSIT,
    OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
    X,
  ],
  // Or, if the courier can't complete the delivery, back to origin.
  [OrderStatus.IN_TRANSIT]: [
    OrderStatus.ARRIVED_AT_DESTINATION,
    OrderStatus.RETURN_INITIATED,
    X,
  ],
  [OrderStatus.ARRIVED_AT_DESTINATION]: [OrderStatus.READY_FOR_COLLECTION, X],
  // Or, not collected within the window (D15), back to the sender.
  [OrderStatus.READY_FOR_COLLECTION]: [
    OrderStatus.COMPLETED,
    OrderStatus.RETURN_INITIATED,
    X,
  ],
  // A return courier picked it up (from the destination shelf, or the
  // forward courier turning back).
  [OrderStatus.RETURN_INITIATED]: [OrderStatus.RETURN_IN_TRANSIT, X],
  [OrderStatus.RETURN_IN_TRANSIT]: [OrderStatus.RETURNED_TO_ORIGIN, X],
  [OrderStatus.RETURNED_TO_ORIGIN]: [
    OrderStatus.READY_FOR_SENDER_COLLECTION,
    X,
  ],
  [OrderStatus.READY_FOR_SENDER_COLLECTION]: [
    OrderStatus.RETURN_COMPLETED,
    // Never collected (merchant parcels, plan D20).
    OrderStatus.DISPOSED,
    X,
  ],
};

export function assertLegalTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  if (!ORDER_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Illegal order transition requested: ${from} -> ${to}`);
  }
}
