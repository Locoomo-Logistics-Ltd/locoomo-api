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
  | 'collected'
  | 'returning_to_sender'
  | 'returned_to_sender'
  | 'return_completed';

export const PUBLIC_STATUS_LABELS: Record<PublicStatus, string> = {
  awaiting_drop_off: 'Awaiting drop-off',
  at_origin_station: 'At origin station',
  on_the_way: 'On the way',
  arrived_at_destination: 'Arrived at destination station',
  ready_for_collection: 'Ready for collection',
  collected: 'Collected',
  returning_to_sender: 'Returning to sender',
  returned_to_sender: 'Returned — ready for sender collection',
  return_completed: 'Returned to sender',
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
  return_initiated: 'returning_to_sender',
  return_in_transit: 'returning_to_sender',
  // Back at the origin; being checked in, then waiting for the sender.
  returned_to_origin: 'returned_to_sender',
  ready_for_sender_collection: 'returned_to_sender',
  return_completed: 'return_completed',
};

// While a parcel is coming back (or waiting there), the origin station is
// where it's headed — the page shows its address and hours.
export const RETURN_PUBLIC_STATUSES: ReadonlySet<PublicStatus> = new Set([
  'returning_to_sender',
  'returned_to_sender',
  'return_completed',
]);

// null for statuses with no public meaning (cancelled/disputed today) —
// the page then treats the parcel as not found rather than inventing copy.
export function toPublicStatus(orderStatus: string): PublicStatus | null {
  return ORDER_STATUS_TO_PUBLIC[orderStatus] ?? null;
}

export const FINAL_PUBLIC_STATUSES: ReadonlySet<PublicStatus> = new Set([
  'collected',
  'return_completed',
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
    case 'return_initiated':
      return {
        status: 'returning_to_sender',
        label: "Delivery couldn't be completed",
      };
    case 'return_in_transit':
      return {
        status: 'returning_to_sender',
        label: `Returning to ${names.origin}`,
      };
    case 'returned_to_origin':
      return {
        status: 'returned_to_sender',
        label: `Back at ${names.origin}`,
      };
    case 'ready_for_sender_collection':
      return {
        status: 'returned_to_sender',
        label: 'Ready for the sender to collect',
      };
    case 'collected_by_sender':
      return { status: 'return_completed', label: 'Collected by the sender' };
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
    case 'returning_to_sender':
      return `The delivery couldn't be completed, so the parcel is going back to ${names.origin}. We'll email the sender when it's ready to collect.`;
    case 'returned_to_sender':
      return `The parcel is back at ${names.origin}. The sender has been emailed a collection code.`;
    case 'return_completed':
      return 'The sender has collected the parcel.';
  }
}
