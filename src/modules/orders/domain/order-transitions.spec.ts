import { OrderStatus } from './order-status.enum';
import { assertLegalTransition, ORDER_TRANSITIONS } from './order-transitions';

describe('order-transitions', () => {
  it('allows the full happy-path chain, one step at a time', () => {
    const chain: OrderStatus[] = [
      OrderStatus.AWAITING_DROP_OFF,
      OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.IN_TRANSIT,
      OrderStatus.ARRIVED_AT_DESTINATION,
      OrderStatus.READY_FOR_COLLECTION,
      OrderStatus.COMPLETED,
    ];

    for (let i = 0; i < chain.length - 1; i++) {
      expect(() => assertLegalTransition(chain[i], chain[i + 1])).not.toThrow();
    }
  });

  it('rejects skipping a step', () => {
    expect(() =>
      assertLegalTransition(
        OrderStatus.AWAITING_DROP_OFF,
        OrderStatus.RIDER_ASSIGNED,
      ),
    ).toThrow(/Illegal order transition/);
  });

  it('rejects moving backwards', () => {
    expect(() =>
      assertLegalTransition(OrderStatus.IN_TRANSIT, OrderStatus.RIDER_ASSIGNED),
    ).toThrow(/Illegal order transition/);
  });

  it('allows the return chain from in transit back to the sender', () => {
    const chain: OrderStatus[] = [
      OrderStatus.IN_TRANSIT,
      OrderStatus.RETURN_INITIATED,
      OrderStatus.RETURN_IN_TRANSIT,
      OrderStatus.RETURNED_TO_ORIGIN,
      OrderStatus.READY_FOR_SENDER_COLLECTION,
      OrderStatus.RETURN_COMPLETED,
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(() => assertLegalTransition(chain[i], chain[i + 1])).not.toThrow();
    }
  });

  it('only starts a return once the parcel has left the origin', () => {
    expect(() =>
      assertLegalTransition(
        OrderStatus.RIDER_ASSIGNED,
        OrderStatus.RETURN_INITIATED,
      ),
    ).toThrow(/Illegal order transition/);
  });

  it('allows a courier release back to waiting before pickup', () => {
    expect(() =>
      assertLegalTransition(
        OrderStatus.RIDER_ASSIGNED,
        OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      ),
    ).not.toThrow();
  });

  it('has no outgoing edges for terminal statuses', () => {
    expect(ORDER_TRANSITIONS[OrderStatus.COMPLETED]).toBeUndefined();
    expect(ORDER_TRANSITIONS[OrderStatus.RETURN_COMPLETED]).toBeUndefined();
    expect(ORDER_TRANSITIONS[OrderStatus.CANCELLED]).toBeUndefined();
    expect(ORDER_TRANSITIONS[OrderStatus.DISPUTED]).toBeUndefined();
  });
});
