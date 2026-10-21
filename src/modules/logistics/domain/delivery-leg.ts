// The courier-neutral vocabulary every logistics provider is mapped onto.
// The order state machine only ever reacts to these — adding a courier means
// writing an adapter that translates *its* statuses into this, never
// touching the order flow.

// One courier's attempt at moving a parcel between two Nodes.
export enum DeliveryLegType {
  FORWARD = 'forward', // origin → destination
  RETURN = 'return', // back to origin (phase 5)
}

export enum DeliveryLegStatus {
  REQUESTED = 'requested', // asked for a courier, none assigned yet
  ASSIGNED = 'assigned', // a courier is coming to pick up
  PICKED_UP = 'picked_up', // courier has the parcel
  DELIVERED = 'delivered', // handed over at the far end — terminal
  RETURNING = 'returning', // courier bringing it back
  RETURNED = 'returned', // handed back at origin — terminal
  CANCELLED = 'cancelled', // ended before pickup — terminal
}

export const ACTIVE_LEG_STATUSES: readonly DeliveryLegStatus[] = [
  DeliveryLegStatus.REQUESTED,
  DeliveryLegStatus.ASSIGNED,
  DeliveryLegStatus.PICKED_UP,
  DeliveryLegStatus.RETURNING,
];

// Things that happen to a leg. Mostly 1:1 with the status they lead to;
// RELEASED (courier dropped the job before pickup) and ATTEMPT_FAILED (a
// drop-off attempt failed, courier will retry) change state differently.
export enum DeliveryEventType {
  ASSIGNED = 'assigned',
  RELEASED = 'released',
  PICKED_UP = 'picked_up',
  ATTEMPT_FAILED = 'attempt_failed',
  DELIVERED = 'delivered',
  RETURNING = 'returning',
  RETURNED = 'returned',
  CANCELLED = 'cancelled',
}

const TRANSITIONS: Record<
  DeliveryEventType,
  { from: readonly DeliveryLegStatus[]; to: DeliveryLegStatus }
> = {
  [DeliveryEventType.ASSIGNED]: {
    from: [DeliveryLegStatus.REQUESTED],
    to: DeliveryLegStatus.ASSIGNED,
  },
  [DeliveryEventType.RELEASED]: {
    from: [DeliveryLegStatus.ASSIGNED],
    to: DeliveryLegStatus.REQUESTED,
  },
  [DeliveryEventType.PICKED_UP]: {
    from: [DeliveryLegStatus.ASSIGNED],
    to: DeliveryLegStatus.PICKED_UP,
  },
  [DeliveryEventType.ATTEMPT_FAILED]: {
    from: [DeliveryLegStatus.PICKED_UP],
    to: DeliveryLegStatus.PICKED_UP,
  },
  [DeliveryEventType.DELIVERED]: {
    from: [DeliveryLegStatus.PICKED_UP],
    to: DeliveryLegStatus.DELIVERED,
  },
  [DeliveryEventType.RETURNING]: {
    from: [DeliveryLegStatus.PICKED_UP],
    to: DeliveryLegStatus.RETURNING,
  },
  [DeliveryEventType.RETURNED]: {
    from: [DeliveryLegStatus.RETURNING],
    to: DeliveryLegStatus.RETURNED,
  },
  [DeliveryEventType.CANCELLED]: {
    from: [DeliveryLegStatus.REQUESTED, DeliveryLegStatus.ASSIGNED],
    to: DeliveryLegStatus.CANCELLED,
  },
};

// The status `event` moves a leg in `current` to, or null if the event
// doesn't apply from there — duplicates and out-of-order deliveries from
// a courier's webhooks land here and are ignored rather than corrupting
// state.
export function nextLegStatus(
  current: DeliveryLegStatus,
  event: DeliveryEventType,
): DeliveryLegStatus | null {
  const rule = TRANSITIONS[event];
  return rule.from.includes(current) ? rule.to : null;
}

export function isTerminal(status: DeliveryLegStatus): boolean {
  return !ACTIVE_LEG_STATUSES.includes(status);
}

// Vehicle classes in Locoomo's own terms; each provider declares which it
// offers and maps them to its own names. Wider than any one courier (Sendii
// has no vans) so a future partner's fleet fits without a migration.
export enum VehicleClass {
  BICYCLE = 'bicycle',
  MOTORBIKE = 'motorbike',
  CAR = 'car',
  VAN = 'van',
  TRUCK = 'truck',
}
