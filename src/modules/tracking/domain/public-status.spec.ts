import { nextStepFor, timelineEntryFor, toPublicStatus } from './public-status';

describe('toPublicStatus', () => {
  it.each([
    ['awaiting_drop_off', 'awaiting_drop_off'],
    ['parcel_received_at_origin', 'at_origin_station'],
    ['rider_assigned', 'at_origin_station'],
    ['in_transit', 'on_the_way'],
    ['arrived_at_destination', 'arrived_at_destination'],
    ['ready_for_collection', 'ready_for_collection'],
    ['completed', 'collected'],
  ])('%s → %s', (orderStatus, expected) => {
    expect(toPublicStatus(orderStatus)).toBe(expected);
  });

  it('has no public meaning for cancelled or unknown statuses', () => {
    expect(toPublicStatus('cancelled')).toBeNull();
    expect(toPublicStatus('something_new')).toBeNull();
  });
});

describe('timelineEntryFor', () => {
  const names = { origin: 'Yaba Node', destination: 'Lekki Node' };

  it('names the stations in the labels', () => {
    expect(timelineEntryFor('parcel_received_at_origin', names)).toEqual({
      status: 'at_origin_station',
      label: 'Dropped off at Yaba Node',
    });
    expect(timelineEntryFor('picked_up_by_rider', names)?.label).toBe(
      'On the way to Lekki Node',
    );
  });

  it('leaves unknown event types off the public timeline', () => {
    expect(timelineEntryFor('internal_audit_note', names)).toBeNull();
  });

  it('gives every public status some next-step copy', () => {
    expect(nextStepFor('ready_for_collection', names)).toContain('Lekki Node');
  });
});
