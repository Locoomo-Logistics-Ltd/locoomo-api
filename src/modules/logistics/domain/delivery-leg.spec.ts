import {
  DeliveryEventType as E,
  DeliveryLegStatus as S,
  isTerminal,
  nextLegStatus,
} from './delivery-leg';

describe('nextLegStatus', () => {
  it.each([
    [S.REQUESTED, E.ASSIGNED, S.ASSIGNED],
    [S.ASSIGNED, E.RELEASED, S.REQUESTED],
    [S.ASSIGNED, E.PICKED_UP, S.PICKED_UP],
    [S.PICKED_UP, E.ATTEMPT_FAILED, S.PICKED_UP],
    [S.PICKED_UP, E.DELIVERED, S.DELIVERED],
    [S.PICKED_UP, E.RETURNING, S.RETURNING],
    [S.RETURNING, E.RETURNED, S.RETURNED],
    [S.REQUESTED, E.CANCELLED, S.CANCELLED],
    [S.ASSIGNED, E.CANCELLED, S.CANCELLED],
  ])('%s + %s → %s', (from, event, to) => {
    expect(nextLegStatus(from, event)).toBe(to);
  });

  it.each([
    [S.REQUESTED, E.PICKED_UP], // can't pick up before assignment
    [S.PICKED_UP, E.CANCELLED], // can't cancel once the parcel moved
    [S.DELIVERED, E.DELIVERED], // duplicate webhook
    [S.DELIVERED, E.PICKED_UP], // late, out-of-order webhook
    [S.CANCELLED, E.ASSIGNED],
  ])('ignores %s + %s', (from, event) => {
    expect(nextLegStatus(from, event)).toBeNull();
  });

  it('treats delivered, returned and cancelled as terminal', () => {
    expect([S.DELIVERED, S.RETURNED, S.CANCELLED].every(isTerminal)).toBe(true);
    expect(
      [S.REQUESTED, S.ASSIGNED, S.PICKED_UP, S.RETURNING].some(isTerminal),
    ).toBe(false);
  });
});
