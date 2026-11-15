export enum OrderEventType {
  ORDER_PLACED = 'order_placed',
  RIDER_ASSIGNED = 'rider_assigned',
  // The assigned courier dropped the job (or it was cancelled) before
  // pickup; the order is waiting for a courier again.
  COURIER_RELEASED = 'courier_released',
  PARCEL_RECEIVED_AT_ORIGIN = 'parcel_received_at_origin',
  PICKED_UP_BY_RIDER = 'picked_up_by_rider',
  ARRIVED_AT_DESTINATION = 'arrived_at_destination',
  READY_FOR_COLLECTION = 'ready_for_collection',
  COLLECTED_BY_RECEIVER = 'collected_by_receiver',
  RETURN_INITIATED = 'return_initiated',
  // A courier took (or let go of) the return job from the destination.
  RETURN_COURIER_ASSIGNED = 'return_courier_assigned',
  RETURN_COURIER_RELEASED = 'return_courier_released',
  // Receiver reminded to collect before the deadline.
  COLLECTION_REMINDER_SENT = 'collection_reminder_sent',
  RETURN_IN_TRANSIT = 'return_in_transit',
  RETURNED_TO_ORIGIN = 'returned_to_origin',
  READY_FOR_SENDER_COLLECTION = 'ready_for_sender_collection',
  COLLECTED_BY_SENDER = 'collected_by_sender',
  REFUSED_AT_DROP_OFF = 'refused_at_drop_off',
  CANCELLED = 'cancelled',
  EXCEPTION_RAISED = 'exception_raised',
  // A wrong ID-check attempt at the counter (audit trail).
  ID_CHECK_FAILED = 'id_check_failed',
  // Merchant changed details (route, parcel, receiver) — no status change.
  DETAILS_UPDATED = 'details_updated',
  // Merchant asked for it back while in transit (turns round on arrival).
  RETURN_REQUESTED = 'return_requested',
}
