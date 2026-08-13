// Same shape (id, orderId, codeHash, expiresAt, usedAt) backs all three —
// RIDER_PICKUP/RIDER_ARRIVAL are rider-requested (Phase 3); RECEIVER_COLLECTION
// is system-generated at READY_FOR_COLLECTION, never rider-requested (Phase 4).
// Defined together now so the Postgres enum column doesn't need an
// ALTER TYPE ... ADD VALUE migration later.
export enum HandoffCodeType {
  RIDER_PICKUP = 'rider_pickup',
  RIDER_ARRIVAL = 'rider_arrival',
  RECEIVER_COLLECTION = 'receiver_collection',
}
