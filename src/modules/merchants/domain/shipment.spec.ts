import {
  addWorkingDays,
  canTransition,
  generateCollectionCode,
  generateTestTrackingCode,
  ShipmentStatus as S,
  simulationPath,
} from './shipment';

describe('shipment status machine and simulator', () => {
  it.each([
    [
      S.CREATED,
      S.COLLECTED,
      [S.RECEIVED, S.IN_TRANSIT, S.READY_FOR_COLLECTION, S.COLLECTED],
    ],
    [S.IN_TRANSIT, S.COLLECTED, [S.READY_FOR_COLLECTION, S.COLLECTED]],
    [
      S.CREATED,
      S.RETURNED,
      [
        S.RECEIVED,
        S.IN_TRANSIT,
        S.READY_FOR_COLLECTION,
        S.RETURNING,
        S.RETURN_READY,
        S.RETURNED,
      ],
    ],
    [
      S.READY_FOR_COLLECTION,
      S.DISPOSED,
      [S.RETURNING, S.RETURN_READY, S.DISPOSED],
    ],
    [S.RETURNING, S.RETURNED, [S.RETURN_READY, S.RETURNED]],
    [S.IN_TRANSIT, S.RETURNING, [S.READY_FOR_COLLECTION, S.RETURNING]],
    [S.CREATED, S.EXCEPTION, [S.RECEIVED, S.EXCEPTION]],
    [S.READY_FOR_COLLECTION, S.EXCEPTION, [S.EXCEPTION]],
    [S.CREATED, S.CANCELLED, [S.CANCELLED]],
    [S.CREATED, S.REFUSED, [S.REFUSED]],
  ])('simulates %s → %s via every step', (from, to, expected) => {
    expect(simulationPath(from, to)).toEqual(expected);
  });

  it.each([
    [S.RECEIVED, S.RECEIVED],
    [S.RECEIVED, S.CREATED],
    [S.RECEIVED, S.CANCELLED],
    [S.COLLECTED, S.RETURNED],
    [S.COLLECTED, S.EXCEPTION],
    [S.RETURN_READY, S.RETURNING],
    [S.CANCELLED, S.RECEIVED],
  ])('refuses to simulate %s → %s', (from, to) => {
    expect(simulationPath(from, to)).toBeNull();
  });

  it('only ever simulates allowed transitions', () => {
    const statuses = Object.values(S);
    for (const from of statuses) {
      for (const to of statuses) {
        const path = simulationPath(from, to);
        if (!path) continue;
        let current = from;
        for (const step of path) {
          expect([current, step, canTransition(current, step)]).toEqual([
            current,
            step,
            true,
          ]);
          current = step;
        }
      }
    }
  });

  it('counts the collection window in Lagos working days', () => {
    // Friday 2026-11-13 10:00 Lagos → 7 working days → Tue 2026-11-24, 23:59:59 Lagos.
    const deadline = addWorkingDays(new Date('2026-11-13T09:00:00Z'), 7);
    expect(deadline.toISOString()).toBe('2026-11-24T22:59:59.000Z');
    // Saturday counts from the next Monday.
    expect(
      addWorkingDays(new Date('2026-11-14T12:00:00Z'), 1).toISOString(),
    ).toBe('2026-11-16T22:59:59.000Z');
  });

  it('generates test tracking and collection codes', () => {
    expect(generateTestTrackingCode()).toMatch(
      /^LCT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(generateCollectionCode()).toMatch(/^\d{6}$/);
  });
});
