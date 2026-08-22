import { Injectable } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { ParcelSize } from '../../../common/parcel-size.enum';
import { IllegalOrderTransitionException } from '../domain/exceptions/illegal-order-transition.exception';
import { OrderEventType } from '../domain/order-event-type.enum';
import { assertLegalTransition } from '../domain/order-transitions';
import { OrderStatus } from '../domain/order-status.enum';
import { generateTrackingCode } from '../domain/tracking-code';
import { OrderEventEntity } from '../infrastructure/entities/order-event.entity';
import { OrderEntity } from '../infrastructure/entities/order.entity';

// 32^8 possible codes — a same-transaction retry loop is the correctness
// guarantee (the unique index is what actually prevents a collision), this
// cap just stops a pathological run of bad luck from looping forever.
const MAX_TRACKING_CODE_ATTEMPTS = 5;

export interface CreateOrderFromPaidIntentFields {
  paymentIntentId: string;
  consumerId: string;
  originNodeId: string;
  destinationNodeId: string;
  receiverFullName: string;
  receiverEmail: string;
  receiverPhone: string;
  parcelDescription: string;
  parcelSize: ParcelSize;
  amountKobo: number;
  destinationFeeKobo: number;
}

@Injectable()
export class OrdersService {
  async createFromPaidIntent(
    fields: CreateOrderFromPaidIntentFields,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    const orderRepo = manager.getRepository(OrderEntity);
    const order = await this.saveWithTrackingCode(orderRepo, fields);

    await this.appendEvent(manager, order.id, OrderEventType.ORDER_PLACED, {
      paymentIntentId: fields.paymentIntentId,
      amountKobo: fields.amountKobo,
    });

    return order;
  }

  // Guarded, atomic status transition — every handoff step calls this
  // instead of hand-rolling its own UPDATE. assertLegalTransition() catches
  // a caller requesting an edge that isn't in the graph at all (a bug); the
  // conditional UPDATE affecting zero rows catches the order not actually
  // being in fromStatus right now (stale state or a lost race) — same
  // response either way, IllegalOrderTransitionException.
  async transition(
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
    manager: EntityManager,
    eventType: OrderEventType,
    eventPayload: Record<string, unknown> = {},
  ): Promise<OrderEntity> {
    assertLegalTransition(fromStatus, toStatus);

    // manager.query() on an UPDATE ... RETURNING resolves to a [rows,
    // rowCount] tuple (unlike a plain SELECT, which resolves to rows
    // directly) — destructure, don't index straight into it.
    const [rows] = await manager.query<[OrderEntity[], number]>(
      `UPDATE orders SET status = $1, "updatedAt" = now()
        WHERE id = $2 AND status = $3
        RETURNING *`,
      [toStatus, orderId, fromStatus],
    );
    const order = rows[0];
    if (!order) {
      throw new IllegalOrderTransitionException(orderId, fromStatus, toStatus);
    }

    await this.appendEvent(manager, orderId, eventType, eventPayload);
    return order;
  }

  // Narrow export for handoffs' accept-order flow (decision-#12-style
  // pattern: the owning module bakes in its own status/event enum values,
  // the caller never needs to import OrderStatus/OrderEventType). Sets
  // riderId atomically with the status flip — "riderId IS NULL" in the
  // WHERE clause is the race guard: exactly one concurrent accept() wins.
  async assignRider(
    orderId: string,
    riderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    assertLegalTransition(
      OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      OrderStatus.RIDER_ASSIGNED,
    );

    const [rows] = await manager.query<[OrderEntity[], number]>(
      `UPDATE orders SET status = $1, "riderId" = $2, "updatedAt" = now()
        WHERE id = $3 AND status = $4 AND "riderId" IS NULL
        RETURNING *`,
      [
        OrderStatus.RIDER_ASSIGNED,
        riderId,
        orderId,
        OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      ],
    );
    const order = rows[0];
    if (!order) {
      throw new IllegalOrderTransitionException(
        orderId,
        OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
        OrderStatus.RIDER_ASSIGNED,
      );
    }

    await this.appendEvent(manager, orderId, OrderEventType.RIDER_ASSIGNED, {
      riderId,
    });
    return order;
  }

  // Narrow export for handoffs' origin drop-off scan — Consumer hands the
  // parcel to the origin Node operator, who confirms receipt. Unilateral
  // (no second party's code needed here — see conversation on why this
  // step differs from the rider handoffs), so this is a plain wrapper
  // around transition() with no extra guard beyond the status check.
  async markReceivedAtOrigin(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.AWAITING_DROP_OFF,
      OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      manager,
      OrderEventType.PARCEL_RECEIVED_AT_ORIGIN,
    );
  }

  // Narrow exports for handoffs' rider<->Node code confirmations. Both are
  // plain wrappers around transition() — the actual guard (right code,
  // right requester) lives in handoffs' ConfirmHandoffService, not here;
  // this only owns whether the status edge itself is legal.
  async markPickedUpByRider(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.IN_TRANSIT,
      manager,
      OrderEventType.PICKED_UP_BY_RIDER,
    );
  }

  async markArrivedAtDestination(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.IN_TRANSIT,
      OrderStatus.ARRIVED_AT_DESTINATION,
      manager,
      OrderEventType.ARRIVED_AT_DESTINATION,
    );
  }

  // Narrow export for handoffs' destination-intake step — mirrors
  // markReceivedAtOrigin (unilateral operator confirmation, no code
  // involved), but on the destination side. The caller issues the
  // RECEIVER_COLLECTION code as a separate step in the same transaction.
  async markReadyForCollection(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.ARRIVED_AT_DESTINATION,
      OrderStatus.READY_FOR_COLLECTION,
      manager,
      OrderEventType.READY_FOR_COLLECTION,
    );
  }

  // Narrow export for handoffs' final collection step. eventPayload carries
  // the operator's identityConfirmed attestation (not a system-enforced
  // name match — see ConfirmCollectionService) into the permanent
  // OrderEvent audit trail.
  async markCollected(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown> = {},
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.READY_FOR_COLLECTION,
      OrderStatus.COMPLETED,
      manager,
      OrderEventType.COLLECTED_BY_RECEIVER,
      eventPayload,
    );
  }

  private async appendEvent(
    manager: EntityManager,
    orderId: string,
    type: OrderEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventRepo = manager.getRepository(OrderEventEntity);
    await eventRepo.save(eventRepo.create({ orderId, type, payload }));
  }

  private async saveWithTrackingCode(
    orderRepo: Repository<OrderEntity>,
    fields: CreateOrderFromPaidIntentFields,
  ): Promise<OrderEntity> {
    for (let attempt = 1; attempt <= MAX_TRACKING_CODE_ATTEMPTS; attempt++) {
      try {
        return await orderRepo.save(
          orderRepo.create({
            paymentIntentId: fields.paymentIntentId,
            consumerId: fields.consumerId,
            originNodeId: fields.originNodeId,
            destinationNodeId: fields.destinationNodeId,
            receiverFullName: fields.receiverFullName,
            receiverEmail: fields.receiverEmail,
            receiverPhone: fields.receiverPhone,
            parcelDescription: fields.parcelDescription,
            parcelSize: fields.parcelSize,
            amountKobo: fields.amountKobo,
            destinationFeeKobo: fields.destinationFeeKobo,
            status: OrderStatus.AWAITING_DROP_OFF,
            trackingCode: generateTrackingCode(),
          }),
        );
      } catch (error) {
        if (
          !isUniqueViolation(error) ||
          attempt === MAX_TRACKING_CODE_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    // Unreachable — the loop above always either returns or throws.
    throw new Error('Failed to generate a unique tracking code');
  }
}
