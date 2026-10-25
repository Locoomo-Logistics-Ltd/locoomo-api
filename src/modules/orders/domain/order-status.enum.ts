export enum OrderStatus {
  AWAITING_DROP_OFF = 'awaiting_drop_off',
  PARCEL_RECEIVED_AT_ORIGIN = 'parcel_received_at_origin',
  RIDER_ASSIGNED = 'rider_assigned',
  IN_TRANSIT = 'in_transit',
  ARRIVED_AT_DESTINATION = 'arrived_at_destination',
  READY_FOR_COLLECTION = 'ready_for_collection',
  COMPLETED = 'completed',
  // Returns (failed delivery → back to the origin Pickup Station, where the
  // sender collects it).
  RETURN_INITIATED = 'return_initiated',
  RETURN_IN_TRANSIT = 'return_in_transit',
  RETURNED_TO_ORIGIN = 'returned_to_origin',
  READY_FOR_SENDER_COLLECTION = 'ready_for_sender_collection',
  RETURN_COMPLETED = 'return_completed',
  CANCELLED = 'cancelled',
  DISPUTED = 'disputed',
}
