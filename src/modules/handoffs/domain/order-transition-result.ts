// Structural shape every OrdersService narrow-export handoffs calls
// (assignRider, markReceivedAtOrigin, ...) hands back — kept local to
// handoffs so nothing here needs to import orders' own OrderEntity/
// OrderStatus (cross-module domain/infrastructure imports are forbidden by
// the boundary rule). OrderEntity's actual shape is a superset of this,
// which TypeScript accepts structurally with no explicit cast.
export interface OrderTransitionResult {
  id: string;
  trackingCode: string;
  status: string;
  originNodeId: string;
  destinationNodeId: string;
  // Set after drop-off/intake (the number to write on the parcel), null
  // once it has left the Node.
  shelfNumber: number | null;
}
