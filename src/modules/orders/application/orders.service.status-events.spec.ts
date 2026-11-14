import type { EntityManager } from 'typeorm';
import { OrderEventType } from '../domain/order-event-type.enum';
import { OrderStatus } from '../domain/order-status.enum';
import { IllegalOrderTransitionException } from '../domain/exceptions/illegal-order-transition.exception';
import {
  OrderStatusChanged,
  OrderStatusEventBus,
} from './order-status-event-bus';
import { OrdersService } from './orders.service';
import { PublicHolidayService } from './public-holiday.service';

function fakeManager(returnedRow: Record<string, unknown> | undefined): {
  manager: EntityManager;
  saved: unknown[];
} {
  const saved: unknown[] = [];
  const manager = {
    query: jest.fn().mockResolvedValue([returnedRow ? [returnedRow] : [], 1]),
    getRepository: () => ({
      create: (value: unknown) => value,
      save: (value: unknown) => {
        saved.push(value);
        return Promise.resolve(value);
      },
    }),
  } as unknown as EntityManager;
  return { manager, saved };
}

describe('OrdersService status events', () => {
  let bus: OrderStatusEventBus;
  let received: OrderStatusChanged[];
  let service: OrdersService;

  beforeEach(() => {
    bus = new OrderStatusEventBus();
    received = [];
    bus.subscribe({
      onOrderStatusChanged: (change) => {
        received.push(change);
        return Promise.resolve();
      },
    });
    service = new OrdersService(bus, {
      collectionDeadline: () =>
        Promise.resolve(new Date('2026-11-24T22:59:59Z')),
    } as unknown as PublicHolidayService);
  });

  it('publishes from/to status and event type inside the caller transaction', async () => {
    const { manager } = fakeManager({
      id: 'o1',
      trackingCode: 'LCM-AAAA-BBBB',
      status: OrderStatus.IN_TRANSIT,
    });

    await service.transition(
      'o1',
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.IN_TRANSIT,
      manager,
      OrderEventType.PICKED_UP_BY_RIDER,
    );

    expect(received).toEqual([
      expect.objectContaining({
        orderId: 'o1',
        trackingCode: 'LCM-AAAA-BBBB',
        fromStatus: OrderStatus.RIDER_ASSIGNED,
        toStatus: OrderStatus.IN_TRANSIT,
        eventType: OrderEventType.PICKED_UP_BY_RIDER,
      }),
    ]);
  });

  it('publishes for a courier release (a status change outside transition())', async () => {
    const { manager } = fakeManager({
      id: 'o1',
      trackingCode: 'LCM-AAAA-BBBB',
      status: OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
    });

    await service.markCourierReleased('o1', manager);

    expect(received[0]).toMatchObject({
      fromStatus: OrderStatus.RIDER_ASSIGNED,
      toStatus: OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      eventType: OrderEventType.COURIER_RELEASED,
    });
  });

  it('publishes nothing when the transition loses its race', async () => {
    const { manager } = fakeManager(undefined);

    await expect(
      service.transition(
        'o1',
        OrderStatus.RIDER_ASSIGNED,
        OrderStatus.IN_TRANSIT,
        manager,
        OrderEventType.PICKED_UP_BY_RIDER,
      ),
    ).rejects.toBeInstanceOf(IllegalOrderTransitionException);
    expect(received).toEqual([]);
  });

  it('lets a failing subscriber abort the change (it rolls back with the transaction)', async () => {
    bus.subscribe({
      onOrderStatusChanged: () => Promise.reject(new Error('boom')),
    });
    const { manager } = fakeManager({
      id: 'o1',
      trackingCode: 'LCM-AAAA-BBBB',
      status: OrderStatus.IN_TRANSIT,
    });

    await expect(
      service.transition(
        'o1',
        OrderStatus.RIDER_ASSIGNED,
        OrderStatus.IN_TRANSIT,
        manager,
        OrderEventType.PICKED_UP_BY_RIDER,
      ),
    ).rejects.toThrow('boom');
  });
});
