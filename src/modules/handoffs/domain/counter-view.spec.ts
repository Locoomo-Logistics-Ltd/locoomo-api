import { maskReceiver, nextActionFor, nodeRoleFor } from './counter-view';

describe('nodeRoleFor', () => {
  const order = (status: string) => ({
    status,
    originNodeId: 'origin',
    destinationNodeId: 'destination',
  });

  it('is whichever side the caller is a member of', () => {
    expect(nodeRoleFor(order('in_transit'), ['origin'])).toBe('origin');
    expect(nodeRoleFor(order('awaiting_drop_off'), ['destination'])).toBe(
      'destination',
    );
  });

  it('follows the parcel when the caller is a member at both Nodes', () => {
    const both = ['origin', 'destination'];
    expect(nodeRoleFor(order('rider_assigned'), both)).toBe('origin');
    expect(nodeRoleFor(order('in_transit'), both)).toBe('destination');
  });
});

describe('nextActionFor', () => {
  it.each([
    ['awaiting_drop_off', 'origin', 'confirm_drop_off'],
    ['parcel_received_at_origin', 'origin', 'await_courier'],
    ['rider_assigned', 'origin', 'hand_to_rider'],
    ['in_transit', 'origin', 'none'],
    ['awaiting_drop_off', 'destination', 'none'],
    ['rider_assigned', 'destination', 'await_arrival'],
    ['in_transit', 'destination', 'receive_from_rider'],
    ['arrived_at_destination', 'destination', 'intake'],
    ['ready_for_collection', 'destination', 'hand_to_receiver'],
    ['completed', 'destination', 'none'],
    ['some_future_status', 'origin', 'none'],
  ] as const)('%s at %s → %s', (status, role, expected) => {
    expect(nextActionFor(status, role)).toBe(expected);
  });
});

describe('nextActionFor with an external courier', () => {
  it("swaps code entry for reading out the courier's code", () => {
    expect(
      nextActionFor('rider_assigned', 'origin', 'give_code_to_courier'),
    ).toBe('hand_to_courier');
    expect(
      nextActionFor('in_transit', 'destination', 'give_code_to_courier'),
    ).toBe('receive_from_courier');
  });

  it('leaves actions that involve no courier alone', () => {
    expect(
      nextActionFor(
        'arrived_at_destination',
        'destination',
        'give_code_to_courier',
      ),
    ).toBe('intake');
  });
});

describe('maskReceiver', () => {
  it('shows initials and the last four digits only', () => {
    expect(maskReceiver('Chidinma Okafor', '+2348012345678')).toBe(
      'C. O. · ***5678',
    );
  });

  it('copes with extra whitespace, lowercase and long names', () => {
    expect(maskReceiver('  ada  obi ngozi eze ', '0803 123 4567')).toBe(
      'A. O. N. · ***4567',
    );
  });
});
