// Pure logic behind the Node app's scan screen and work queues: which side
// of an order the caller's Node is on, and the one thing staff there should
// do next. Statuses are compared as strings (the order status enum lives in
// orders/domain, which this module can't import).

export type NodeRole = 'origin' | 'destination';

export type NextAction =
  | 'confirm_drop_off'
  | 'await_courier'
  | 'hand_to_rider'
  | 'hand_to_courier'
  | 'await_arrival'
  | 'receive_from_rider'
  | 'receive_from_courier'
  | 'intake'
  | 'hand_to_receiver'
  | 'return_intake'
  | 'hand_to_sender'
  | 'none';

// Statuses during which the parcel's business is at the origin Node —
// before it leaves, and again once a failed delivery is coming back.
const ORIGIN_PHASE = new Set([
  'awaiting_drop_off',
  'parcel_received_at_origin',
  'rider_assigned',
  'return_initiated',
  'return_in_transit',
  'returned_to_origin',
  'ready_for_sender_collection',
]);

// Usually one side is the caller's. When an operator is a member at both
// Nodes (one owner, two branches), the side that matters is wherever the
// parcel's business currently is.
export function nodeRoleFor(
  order: { status: string; originNodeId: string; destinationNodeId: string },
  myNodeIds: readonly string[],
): NodeRole {
  const atOrigin = myNodeIds.includes(order.originNodeId);
  const atDestination = myNodeIds.includes(order.destinationNodeId);
  if (atOrigin && atDestination) {
    return ORIGIN_PHASE.has(order.status) ? 'origin' : 'destination';
  }
  return atOrigin ? 'origin' : 'destination';
}

const ORIGIN_ACTIONS: Record<string, NextAction> = {
  awaiting_drop_off: 'confirm_drop_off',
  parcel_received_at_origin: 'await_courier',
  rider_assigned: 'hand_to_rider',
  // Returns come back to the origin counter.
  return_initiated: 'await_arrival',
  return_in_transit: 'receive_from_rider',
  returned_to_origin: 'return_intake',
  ready_for_sender_collection: 'hand_to_sender',
};

const DESTINATION_ACTIONS: Record<string, NextAction> = {
  rider_assigned: 'await_arrival',
  in_transit: 'receive_from_rider',
  arrived_at_destination: 'intake',
  ready_for_collection: 'hand_to_receiver',
};

// How the current courier proves a handover (from the delivery leg):
// in-house riders show a code staff enter; external couriers are read a
// code by staff and enter it in their own app.
export type HandoverMode = 'enter_rider_code' | 'give_code_to_courier';

const COURIER_VARIANTS: Partial<Record<NextAction, NextAction>> = {
  hand_to_rider: 'hand_to_courier',
  receive_from_rider: 'receive_from_courier',
};

export function nextActionFor(
  status: string,
  role: NodeRole,
  handover: HandoverMode = 'enter_rider_code',
): NextAction {
  const actions = role === 'origin' ? ORIGIN_ACTIONS : DESTINATION_ACTIONS;
  const action = actions[status] ?? 'none';
  return handover === 'give_code_to_courier'
    ? (COURIER_VARIANTS[action] ?? action)
    : action;
}

// "C. O. · ***5678" — enough for counter staff to match a parcel to the
// person in front of them, without exposing the receiver's details on every
// scan. Full details stay limited to the collection step.
export function maskReceiver(fullName: string, phone: string): string {
  const initials = fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(' ');
  const digits = phone.replace(/\D/g, '');
  return `${initials} · ***${digits.slice(-4)}`;
}
