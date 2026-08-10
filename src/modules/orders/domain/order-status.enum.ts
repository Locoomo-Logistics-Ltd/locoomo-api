export enum OrderStatus {
  AWAITING_DROP_OFF = 'awaiting_drop_off',
  PARCEL_RECEIVED_AT_ORIGIN = 'parcel_received_at_origin',
  RIDER_ASSIGNED = 'rider_assigned',
  IN_TRANSIT = 'in_transit',
  ARRIVED_AT_DESTINATION = 'arrived_at_destination',
  READY_FOR_COLLECTION = 'ready_for_collection',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  DISPUTED = 'disputed',
}
