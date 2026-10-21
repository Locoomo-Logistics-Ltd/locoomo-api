// What the public tracking page may say about a parcel. Deliberately coarser
// than the internal order status, and the only vocabulary that leaves the
// system on an unauthenticated route. Statuses and event types are matched
// as strings — they belong to the orders module.

export type PublicStatus =
  | 'awaiting_drop_off'
  | 'at_origin_station'
  | 'on_the_way'
  | 'arrived_at_destination'
  | 'ready_for_collection'
  | 'collected';

export const PUBLIC_STATUS_LABELS: Record<PublicStatus, string> = {
  awaiting_drop_off: 'Awaiting drop-off',
  at_origin_station: 'At origin station',
  on_the_way: 'On the way',
  arrived_at_destination: 'Arrived at destination station',
  ready_for_collection: 'Ready for collection',
  collected: 'Collected',
};

const ORDER_STATUS_TO_PUBLIC: Record<string, PublicStatus> = {
  awaiting_drop_off: 'awaiting_drop_off',
  parcel_received_at_origin: 'at_origin_station',
  // A rider has accepted the job but hasn't collected the parcel yet.
  rider_assigned: 'at_origin_station',
  in_transit: 'on_the_way',
  arrived_at_destination: 'arrived_at_destination',
  ready_for_collection: 'ready_for_collection',
  completed: 'collected',
};

// null for statuses with no public meaning (cancelled/disputed today) —
// the page then treats the parcel as not found rather than inventing copy.
export function toPublicStatus(orderStatus: string): PublicStatus | null {
  return ORDER_STATUS_TO_PUBLIC[orderStatus] ?? null;
}

export const FINAL_PUBLIC_STATUSES: ReadonlySet<PublicStatus> = new Set([
  'collected',
]);

export interface StationNames {
  origin: string;
  destination: string;
}

export interface TimelineEntry {
  status: PublicStatus | 'order_placed';
  label: string;
}

// order_events type → timeline entry. Unknown types are left off the
// public timeline rather than leaking internal event names.
export function timelineEntryFor(
  eventType: string,
  names: StationNames,
): TimelineEntry | null {
  switch (eventType) {
    case 'order_placed':
      return { status: 'order_placed', label: 'Order placed' };
    case 'parcel_received_at_origin':
      return {
        status: 'at_origin_station',
        label: `Dropped off at ${names.origin}`,
      };
    case 'rider_assigned':
      return { status: 'at_origin_station', label: 'Rider assigned' };
    case 'picked_up_by_rider':
      return {
        status: 'on_the_way',
        label: `On the way to ${names.destination}`,
      };
    case 'arrived_at_destination':
      return {
        status: 'arrived_at_destination',
        label: `Arrived at ${names.destination}`,
      };
    case 'ready_for_collection':
      return { status: 'ready_for_collection', label: 'Ready for collection' };
    case 'collected_by_receiver':
      return { status: 'collected', label: 'Collected' };
    default:
      return null;
  }
}

export function nextStepFor(status: PublicStatus, names: StationNames): string {
  switch (status) {
    case 'awaiting_drop_off':
      return `Waiting for the sender to drop the parcel off at ${names.origin}.`;
    case 'at_origin_station':
      return `The parcel is at ${names.origin} and will be on its way to ${names.destination} soon.`;
    case 'on_the_way':
      return `The parcel is on its way to ${names.destination}. We'll email the receiver a collection code when it's ready.`;
    case 'arrived_at_destination':
      return `The parcel has reached ${names.destination} and is being checked in. The receiver will get a collection code by email shortly.`;
    case 'ready_for_collection':
      return `Ready at ${names.destination}. Bring the collection code from the email and a form of ID.`;
    case 'collected':
      return 'The parcel has been collected.';
  }
}
