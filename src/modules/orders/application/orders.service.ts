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
import { OrderStatusEventBus } from './order-status-event-bus';
import { PublicHolidayService } from './public-holiday.service';

// 32^8 possible codes — a same-transaction retry loop is the correctness
// guarantee (the unique index is what actually prevents a collision), this
// cap just stops a pathological run of bad luck from looping forever.
const MAX_TRACKING_CODE_ATTEMPTS = 5;

export interface ProofOfDelivery {
  method: 'code' | 'id_check';
  // Defaults to the receiver's name (code collection).
  collectorName: string | null;
  photoPublicId: string | null;
}

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
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  handling: string[];
  vehicleClass: string | null;
  amountKobo: number;
  destinationFeeKobo: number;
}

// A merchant's live shipment (plan §5.1): no consumer, no payment intent
// (paid from the merchant wallet), receiver email optional. Unlike consumer
// orders, it holds no origin slot until the parcel is received (§5.2).
export interface CreateMerchantOrderFields {
  merchantId: string;
  originNodeId: string;
  destinationNodeId: string;
  receiverFullName: string;
  receiverEmail: string | null;
  receiverPhone: string;
  parcelDescription: string;
  parcelSize: ParcelSize;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  handling: string[];
  vehicleClass: string | null;
  amountKobo: number;
  destinationFeeKobo: number;
}

// What the counter measured at drop-off (any subset).
export interface MeasuredParcel {
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  size?: ParcelSize;
}

// Statuses from which a merchant may still ask for a parcel back without
// it having reached the buyer's shelf yet (it turns round on arrival).
const RETURN_REQUESTABLE: readonly OrderStatus[] = [
  OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
  OrderStatus.RIDER_ASSIGNED,
  OrderStatus.IN_TRANSIT,
  OrderStatus.ARRIVED_AT_DESTINATION,
];

@Injectable()
export class OrdersService {
  constructor(
    private readonly statusEvents: OrderStatusEventBus,
    private readonly holidays: PublicHolidayService,
  ) {}

  async createForMerchant(
    fields: CreateMerchantOrderFields,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    const order = await this.saveWithTrackingCode(
      manager.getRepository(OrderEntity),
      {
        ...fields,
        source: 'merchant',
        consumerId: null,
        paymentIntentId: null,
      },
    );
    await this.appendEvent(manager, order.id, OrderEventType.ORDER_PLACED, {
      merchantId: fields.merchantId,
      amountKobo: fields.amountKobo,
    });
    await this.publishStatusChange(
      manager,
      order,
      null,
      OrderEventType.ORDER_PLACED,
    );
    return order;
  }

  // Merchant edits before drop-off (route, parcel, re-quoted price).
  async updateBeforeDropOff(
    orderId: string,
    changes: Partial<
      Pick<
        CreateMerchantOrderFields,
        | 'destinationNodeId'
        | 'parcelDescription'
        | 'parcelSize'
        | 'weightKg'
        | 'lengthCm'
        | 'widthCm'
        | 'heightCm'
        | 'handling'
        | 'vehicleClass'
        | 'amountKobo'
        | 'destinationFeeKobo'
      >
    >,
    manager: EntityManager,
  ): Promise<void> {
    const result = await manager
      .getRepository(OrderEntity)
      .createQueryBuilder()
      .update()
      .set(changes)
      .where('id = :orderId AND status = :status', {
        orderId,
        status: OrderStatus.AWAITING_DROP_OFF,
      })
      .execute();
    if (!result.affected) {
      throw new IllegalOrderTransitionException(
        orderId,
        OrderStatus.AWAITING_DROP_OFF,
        OrderStatus.AWAITING_DROP_OFF,
      );
    }
    await this.appendEvent(manager, orderId, OrderEventType.DETAILS_UPDATED, {
      fields: Object.keys(changes),
    });
  }

  // New receiver contact (until collected). Returns the order's status so
  // the caller can reissue a collection code if it's already shelved.
  async updateReceiver(
    orderId: string,
    receiver: {
      receiverFullName?: string;
      receiverPhone?: string;
      receiverEmail?: string | null;
    },
    manager: EntityManager,
  ): Promise<OrderStatus> {
    const [rows] = await manager.query<[{ status: OrderStatus }[], number]>(
      `UPDATE orders
          SET "receiverFullName" = COALESCE($2, "receiverFullName"),
              "receiverPhone" = COALESCE($3, "receiverPhone"),
              "receiverEmail" = CASE WHEN $4::boolean THEN $5 ELSE "receiverEmail" END,
              "updatedAt" = now()
        WHERE id = $1 AND status NOT IN ('completed', 'return_completed', 'cancelled', 'refused', 'exception')
        RETURNING status`,
      [
        orderId,
        receiver.receiverFullName ?? null,
        receiver.receiverPhone ?? null,
        receiver.receiverEmail !== undefined,
        receiver.receiverEmail ?? null,
      ],
    );
    if (!rows[0]) {
      throw new IllegalOrderTransitionException(
        orderId,
        OrderStatus.READY_FOR_COLLECTION,
        OrderStatus.READY_FOR_COLLECTION,
      );
    }
    await this.appendEvent(manager, orderId, OrderEventType.DETAILS_UPDATED, {
      fields: Object.keys(receiver),
    });
    return rows[0].status;
  }

  // The sender wants it back while it's on its way (plan §6.3 intercept).
  // No status change: the destination turns it round on arrival instead of
  // offering it to the buyer. False if it's past that point.
  async requestReturn(
    orderId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    const [rows] = await manager.query<[{ id: string }[], number]>(
      `UPDATE orders SET "returnRequestedAt" = now(), "updatedAt" = now()
        WHERE id = $1 AND status = ANY($2) AND "returnRequestedAt" IS NULL
        RETURNING id`,
      [orderId, RETURN_REQUESTABLE],
    );
    if (!rows[0]) {
      return false;
    }
    await this.appendEvent(manager, orderId, OrderEventType.RETURN_REQUESTED, {
      reason: 'merchant_request',
    });
    return true;
  }

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
    await this.publishStatusChange(
      manager,
      order,
      null,
      OrderEventType.ORDER_PLACED,
    );

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
    await this.publishStatusChange(manager, order, fromStatus, eventType);
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
    await this.publishStatusChange(
      manager,
      order,
      OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      OrderEventType.RIDER_ASSIGNED,
    );
    return order;
  }

  // Narrow export for handoffs' origin drop-off scan — Consumer hands the
  // parcel to the origin Node operator, who confirms receipt. Unilateral
  // (no second party's code needed here — see conversation on why this
  // step differs from the rider handoffs), so this is a plain wrapper
  // around transition() with no extra guard beyond the status check.
  // An external courier (not a Locoomo rider) accepted the job — same
  // transition as assignRider, but there's no rider user to record; who is
  // carrying it lives on the logistics delivery leg instead.
  async markCourierAssigned(
    orderId: string,
    providerKey: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      OrderStatus.RIDER_ASSIGNED,
      manager,
      OrderEventType.RIDER_ASSIGNED,
      { providerKey },
    );
  }

  // The courier assigned to this order let it go before pickup (dropped
  // the job, or the delivery was cancelled). The parcel is still on the
  // origin shelf; the order waits for the next courier.
  async markCourierReleased(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown> = {},
  ): Promise<OrderEntity> {
    assertLegalTransition(
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
    );
    const [rows] = await manager.query<[OrderEntity[], number]>(
      `UPDATE orders SET status = $1, "riderId" = NULL, "updatedAt" = now()
        WHERE id = $2 AND status = $3
        RETURNING *`,
      [
        OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
        orderId,
        OrderStatus.RIDER_ASSIGNED,
      ],
    );
    const order = rows[0];
    if (!order) {
      throw new IllegalOrderTransitionException(
        orderId,
        OrderStatus.RIDER_ASSIGNED,
        OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      );
    }
    await this.appendEvent(
      manager,
      orderId,
      OrderEventType.COURIER_RELEASED,
      eventPayload,
    );
    await this.publishStatusChange(
      manager,
      order,
      OrderStatus.RIDER_ASSIGNED,
      OrderEventType.COURIER_RELEASED,
    );
    return order;
  }

  // `intake` (merchant parcels, plan E4/D14): the Node it was actually
  // dropped at, when that isn't the declared origin, and what the counter
  // measured. Both are written before the transition so status
  // subscribers (re-pricing) see them.
  async markReceivedAtOrigin(
    orderId: string,
    manager: EntityManager,
    intake: { originNodeId?: string; measured?: MeasuredParcel | null } = {},
  ): Promise<OrderEntity> {
    if (intake.originNodeId) {
      const [rows] = await manager.query<[{ previous: string }[], number]>(
        `UPDATE orders o SET "originNodeId" = $2, "updatedAt" = now()
           FROM (SELECT "originNodeId" AS previous FROM orders WHERE id = $1) old
          WHERE o.id = $1 AND o.status = $3 AND o.source = 'merchant'
            AND o."originNodeId" <> $2
          RETURNING old.previous`,
        [orderId, intake.originNodeId, OrderStatus.AWAITING_DROP_OFF],
      );
      if (rows[0]) {
        await this.appendEvent(
          manager,
          orderId,
          OrderEventType.ORIGIN_REBOUND,
          {
            from: rows[0].previous,
            to: intake.originNodeId,
          },
        );
      }
    }
    if (intake.measured) {
      await manager.query(
        `UPDATE orders SET measured = $2 WHERE id = $1 AND status = $3`,
        [orderId, intake.measured, OrderStatus.AWAITING_DROP_OFF],
      );
    }
    const order = await this.transition(
      orderId,
      OrderStatus.AWAITING_DROP_OFF,
      OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      manager,
      OrderEventType.PARCEL_RECEIVED_AT_ORIGIN,
      {
        ...(intake.originNodeId && { originNodeId: intake.originNodeId }),
        ...(intake.measured && { measured: intake.measured }),
      },
    );
    return this.placeOnShelf(order, order.originNodeId, manager);
  }

  // A merchant parcel re-priced at drop-off (real origin, measured parcel):
  // the order carries the final amount for the courier cap and earnings.
  async repriceAtIntake(
    orderId: string,
    price: {
      amountKobo: number;
      destinationFeeKobo: number;
      vehicleClass: string | null;
    },
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `UPDATE orders SET "amountKobo" = $2, "destinationFeeKobo" = $3,
              "vehicleClass" = $4, "updatedAt" = now()
        WHERE id = $1 AND status = $5`,
      [
        orderId,
        price.amountKobo,
        price.destinationFeeKobo,
        price.vehicleClass,
        OrderStatus.PARCEL_RECEIVED_AT_ORIGIN,
      ],
    );
    await this.appendEvent(manager, orderId, OrderEventType.REPRICED, price);
  }

  // Re-pricing couldn't be done (e.g. the measured parcel fits no vehicle);
  // the quoted price stands. Recorded for ops; never blocks the drop-off.
  async recordRepriceFailure(
    orderId: string,
    reason: string,
    manager: EntityManager,
  ): Promise<void> {
    await this.appendEvent(manager, orderId, OrderEventType.REPRICE_FAILED, {
      reason: reason.slice(0, 500),
    });
  }

  // Narrow exports for handoffs' rider<->Node code confirmations. Both are
  // plain wrappers around transition() — the actual guard (right code,
  // right requester) lives in handoffs' ConfirmHandoffService, not here;
  // this only owns whether the status edge itself is legal.
  async markPickedUpByRider(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    const order = await this.transition(
      orderId,
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.IN_TRANSIT,
      manager,
      OrderEventType.PICKED_UP_BY_RIDER,
    );
    return this.clearShelf(order, manager);
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
    const deadline = await this.holidays.collectionDeadline(new Date());
    // Written before the transition so status subscribers (merchant
    // shipment mirror) already see the deadline. Guarded like the
    // transition itself: a stale call changes nothing, then fails below.
    await manager.query(
      `UPDATE orders SET "collectionDeadlineAt" = $2, "collectionRemindersSent" = 0
        WHERE id = $1 AND status = $3`,
      [orderId, deadline, OrderStatus.ARRIVED_AT_DESTINATION],
    );
    const order = await this.transition(
      orderId,
      OrderStatus.ARRIVED_AT_DESTINATION,
      OrderStatus.READY_FOR_COLLECTION,
      manager,
      OrderEventType.READY_FOR_COLLECTION,
      { collectionDeadlineAt: deadline.toISOString() },
    );
    const shelved = await this.placeOnShelf(
      order,
      order.destinationNodeId,
      manager,
    );
    return {
      ...shelved,
      collectionDeadlineAt: deadline,
      collectionRemindersSent: 0,
    };
  }

  // Narrow export for handoffs' final collection step. eventPayload carries
  // the operator's identityConfirmed attestation (not a system-enforced
  // name match — see ConfirmCollectionService) into the permanent
  // OrderEvent audit trail.
  async markCollected(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown> = {},
    proof: ProofOfDelivery = {
      method: 'code',
      collectorName: null,
      photoPublicId: null,
    },
  ): Promise<OrderEntity> {
    const order = await this.transition(
      orderId,
      OrderStatus.READY_FOR_COLLECTION,
      OrderStatus.COMPLETED,
      manager,
      OrderEventType.COLLECTED_BY_RECEIVER,
      { ...eventPayload, method: proof.method },
    );
    // Proof of delivery (plan §5.4): what merchants get in
    // shipment.collected and what support looks at in a dispute.
    const collectedAt = new Date();
    const collectorName = proof.collectorName ?? order.receiverFullName;
    await manager.query(
      `UPDATE orders SET "collectedAt" = $2, "collectionMethod" = $3,
              "collectorName" = $4, "collectionPhotoPublicId" = $5
        WHERE id = $1`,
      [orderId, collectedAt, proof.method, collectorName, proof.photoPublicId],
    );
    return this.clearShelf(
      {
        ...order,
        collectedAt,
        collectionMethod: proof.method,
        collectorName,
        collectionPhotoPublicId: proof.photoPublicId,
      },
      manager,
    );
  }

  // A wrong attempt at ID-check collection (plan §5.4): counted (5 allowed)
  // and kept in the audit trail.
  async recordIdCheckFailure(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown>,
  ): Promise<number> {
    const [rows] = await manager.query<
      [{ idCheckFailedAttempts: number }[], number]
    >(
      `UPDATE orders SET "idCheckFailedAttempts" = "idCheckFailedAttempts" + 1
        WHERE id = $1 RETURNING "idCheckFailedAttempts"`,
      [orderId],
    );
    await this.appendEvent(
      manager,
      orderId,
      OrderEventType.ID_CHECK_FAILED,
      eventPayload,
    );
    return rows[0]?.idCheckFailedAttempts ?? 0;
  }

  // Turned away at the origin counter (plan §5.3): prohibited, damaged or
  // unsafe. The parcel goes back with whoever brought it.
  async markRefused(
    orderId: string,
    refusal: {
      reason: string;
      note: string | null;
      photoPublicId: string | null;
    },
    manager: EntityManager,
  ): Promise<OrderEntity> {
    const record = { ...refusal, at: new Date().toISOString() };
    const order = await this.transition(
      orderId,
      OrderStatus.AWAITING_DROP_OFF,
      OrderStatus.REFUSED,
      manager,
      OrderEventType.REFUSED_AT_DROP_OFF,
      record,
    );
    await manager.query(`UPDATE orders SET refusal = $2 WHERE id = $1`, [
      orderId,
      JSON.stringify(record),
    ]);
    return { ...order, refusal: record };
  }

  // Ended before anyone dropped it off (merchant cancel, drop-off expiry).
  async markCancelled(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown> = {},
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.AWAITING_DROP_OFF,
      OrderStatus.CANCELLED,
      manager,
      OrderEventType.CANCELLED,
      eventPayload,
    );
  }

  // Lost or damaged in our custody (admin-set, plan §5.3), from whatever
  // status it was in. Returns the previous status so the caller can
  // release what that status was holding (capacity, rider slot).
  async markException(
    orderId: string,
    details: { type: 'lost' | 'damaged'; note: string; byUserId: string },
    manager: EntityManager,
  ): Promise<{ order: OrderEntity; previousStatus: OrderStatus }> {
    const [current] = await manager.query<{ status: OrderStatus }[]>(
      `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!current) {
      throw new IllegalOrderTransitionException(
        orderId,
        OrderStatus.AWAITING_DROP_OFF,
        OrderStatus.EXCEPTION,
      );
    }
    const record = {
      ...details,
      at: new Date().toISOString(),
      previousStatus: current.status,
    };
    let order: OrderEntity;
    try {
      order = await this.transition(
        orderId,
        current.status,
        OrderStatus.EXCEPTION,
        manager,
        OrderEventType.EXCEPTION_RAISED,
        record,
      );
    } catch (error) {
      // Not in our custody (not dropped off yet, or already finished).
      if (
        error instanceof Error &&
        !(error instanceof IllegalOrderTransitionException)
      ) {
        throw new IllegalOrderTransitionException(
          orderId,
          current.status,
          OrderStatus.EXCEPTION,
        );
      }
      throw error;
    }
    await manager.query(`UPDATE orders SET exception = $2 WHERE id = $1`, [
      orderId,
      JSON.stringify(record),
    ]);
    const cleared = await this.clearShelf(order, manager);
    return {
      order: { ...cleared, exception: record },
      previousStatus: current.status,
    };
  }

  // The courier couldn't complete the delivery and is bringing the parcel
  // back to the origin Node. Recorded as both steps of the return (decided,
  // then under way) — for an external courier they happen together.
  async markReturning(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown> = {},
  ): Promise<OrderEntity> {
    await this.setReturnReason(
      orderId,
      'delivery_failed',
      OrderStatus.IN_TRANSIT,
      manager,
    );
    await this.transition(
      orderId,
      OrderStatus.IN_TRANSIT,
      OrderStatus.RETURN_INITIATED,
      manager,
      OrderEventType.RETURN_INITIATED,
      { ...eventPayload, reason: 'delivery_failed' },
    );
    return this.transition(
      orderId,
      OrderStatus.RETURN_INITIATED,
      OrderStatus.RETURN_IN_TRANSIT,
      manager,
      OrderEventType.RETURN_IN_TRANSIT,
    );
  }

  // Not collected by the deadline (D15): off the destination shelf and
  // waiting for a return courier (handoffs dispatches the return leg in
  // the same transaction). The receiver's code is voided by the caller.
  async markUncollected(
    orderId: string,
    manager: EntityManager,
    reason: 'not_collected' | 'merchant_request' = 'not_collected',
  ): Promise<OrderEntity> {
    await this.setReturnReason(
      orderId,
      reason,
      OrderStatus.READY_FOR_COLLECTION,
      manager,
    );
    const order = await this.transition(
      orderId,
      OrderStatus.READY_FOR_COLLECTION,
      OrderStatus.RETURN_INITIATED,
      manager,
      OrderEventType.RETURN_INITIATED,
      { reason },
    );
    // The delivery rider's job ended at the destination; the return gets
    // its own courier (assignReturnCourier needs the slot empty).
    await manager.query(`UPDATE orders SET "riderId" = NULL WHERE id = $1`, [
      orderId,
    ]);
    // The parcel stays on the destination shelf until the return courier
    // collects it; the shelf is cleared at pickup (markReturnPickedUp).
    return { ...order, riderId: null, returnReason: reason };
  }

  // A courier took the return job from the destination. No status change
  // (the order is RETURN_INITIATED until pickup); an in-house rider is
  // recorded so only they can request the pickup code. "riderId IS NULL"
  // is the race guard, as in assignRider.
  async assignReturnCourier(
    orderId: string,
    courier: { riderId: string | null; providerKey: string },
    manager: EntityManager,
  ): Promise<void> {
    const [rows] = await manager.query<[{ id: string }[], number]>(
      `UPDATE orders SET "riderId" = $2, "updatedAt" = now()
        WHERE id = $1 AND status = $3 AND "riderId" IS NULL
        RETURNING id`,
      [orderId, courier.riderId, OrderStatus.RETURN_INITIATED],
    );
    if (rows.length === 0) {
      throw new IllegalOrderTransitionException(
        orderId,
        OrderStatus.RETURN_INITIATED,
        OrderStatus.RETURN_INITIATED,
      );
    }
    await this.appendEvent(
      manager,
      orderId,
      OrderEventType.RETURN_COURIER_ASSIGNED,
      courier,
    );
  }

  async releaseReturnCourier(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown> = {},
  ): Promise<void> {
    await manager.query(
      `UPDATE orders SET "riderId" = NULL, "updatedAt" = now()
        WHERE id = $1 AND status = $2`,
      [orderId, OrderStatus.RETURN_INITIATED],
    );
    await this.appendEvent(
      manager,
      orderId,
      OrderEventType.RETURN_COURIER_RELEASED,
      eventPayload,
    );
  }

  // The return courier collected the parcel from the destination shelf.
  async markReturnPickedUp(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    const order = await this.transition(
      orderId,
      OrderStatus.RETURN_INITIATED,
      OrderStatus.RETURN_IN_TRANSIT,
      manager,
      OrderEventType.RETURN_IN_TRANSIT,
    );
    return this.clearShelf(order, manager);
  }

  async recordCollectionReminder(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `UPDATE orders SET "collectionRemindersSent" = "collectionRemindersSent" + 1
        WHERE id = $1`,
      [orderId],
    );
    await this.appendEvent(
      manager,
      orderId,
      OrderEventType.COLLECTION_REMINDER_SENT,
      eventPayload,
    );
  }

  // Set before the status change that it explains, so status subscribers
  // see it; guarded on the status the change starts from.
  private async setReturnReason(
    orderId: string,
    reason: string,
    fromStatus: OrderStatus,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `UPDATE orders SET "returnReason" = $2 WHERE id = $1 AND status = $3`,
      [orderId, reason, fromStatus],
    );
  }

  // The courier handed the parcel back at the origin Node's counter.
  async markReturnedToOrigin(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    return this.transition(
      orderId,
      OrderStatus.RETURN_IN_TRANSIT,
      OrderStatus.RETURNED_TO_ORIGIN,
      manager,
      OrderEventType.RETURNED_TO_ORIGIN,
    );
  }

  // Origin staff shelved the returned parcel — it gets a shelf number there
  // again, and the sender is sent a collection code.
  async markReadyForSenderCollection(
    orderId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    const order = await this.transition(
      orderId,
      OrderStatus.RETURNED_TO_ORIGIN,
      OrderStatus.READY_FOR_SENDER_COLLECTION,
      manager,
      OrderEventType.READY_FOR_SENDER_COLLECTION,
    );
    return this.placeOnShelf(order, order.originNodeId, manager);
  }

  async markCollectedBySender(
    orderId: string,
    manager: EntityManager,
    eventPayload: Record<string, unknown> = {},
  ): Promise<OrderEntity> {
    const order = await this.transition(
      orderId,
      OrderStatus.READY_FOR_SENDER_COLLECTION,
      OrderStatus.RETURN_COMPLETED,
      manager,
      OrderEventType.COLLECTED_BY_SENDER,
      eventPayload,
    );
    return this.clearShelf(order, manager);
  }

  // Gives the parcel the lowest shelf number not currently in use at
  // `nodeId`. The transaction-scoped advisory lock serialises concurrent
  // assignments at the same Node (two drop-offs at once would otherwise both
  // pick the same "lowest free" number); the unique index on
  // (shelfNodeId, shelfNumber) is the backstop. Numbers are reused as soon
  // as a parcel leaves, so they stay short.
  private async placeOnShelf(
    order: OrderEntity,
    nodeId: string,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [nodeId],
    );
    const [rows] = await manager.query<[{ shelfNumber: number }[], number]>(
      `UPDATE orders
          SET "shelfNodeId" = $1,
              "shelfNumber" = (
                SELECT MIN(n)
                  FROM generate_series(
                         1,
                         (SELECT COUNT(*) + 1 FROM orders WHERE "shelfNodeId" = $1)::int
                       ) AS n
                 WHERE NOT EXISTS (
                   SELECT 1 FROM orders WHERE "shelfNodeId" = $1 AND "shelfNumber" = n
                 )
              )
        WHERE id = $2
        RETURNING "shelfNumber"`,
      [nodeId, order.id],
    );
    return { ...order, shelfNodeId: nodeId, shelfNumber: rows[0].shelfNumber };
  }

  private async clearShelf(
    order: OrderEntity,
    manager: EntityManager,
  ): Promise<OrderEntity> {
    await manager.query(
      `UPDATE orders SET "shelfNodeId" = NULL, "shelfNumber" = NULL WHERE id = $1`,
      [order.id],
    );
    return { ...order, shelfNodeId: null, shelfNumber: null };
  }

  // Every status-changing path funnels through here (creation, transition(),
  // assignRider(), markCourierReleased()) — a new status-changing method
  // must call it too, or subscribers silently miss that change.
  private async publishStatusChange(
    manager: EntityManager,
    order: OrderEntity,
    fromStatus: OrderStatus | null,
    eventType: OrderEventType,
  ): Promise<void> {
    await this.statusEvents.publish(
      {
        orderId: order.id,
        trackingCode: order.trackingCode,
        fromStatus,
        toStatus: order.status,
        eventType,
        occurredAt: new Date(),
        source: order.source ?? 'consumer',
        merchantId: order.merchantId ?? null,
      },
      manager,
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
    fields:
      | (CreateOrderFromPaidIntentFields & { source?: 'consumer' })
      | (CreateMerchantOrderFields & {
          source: 'merchant';
          consumerId: null;
          paymentIntentId: null;
        }),
  ): Promise<OrderEntity> {
    for (let attempt = 1; attempt <= MAX_TRACKING_CODE_ATTEMPTS; attempt++) {
      try {
        return await orderRepo.save(
          orderRepo.create({
            source: fields.source ?? 'consumer',
            merchantId: 'merchantId' in fields ? fields.merchantId : null,
            paymentIntentId: fields.paymentIntentId,
            consumerId: fields.consumerId,
            originNodeId: fields.originNodeId,
            destinationNodeId: fields.destinationNodeId,
            receiverFullName: fields.receiverFullName,
            receiverEmail: fields.receiverEmail,
            receiverPhone: fields.receiverPhone,
            parcelDescription: fields.parcelDescription,
            parcelSize: fields.parcelSize,
            weightKg: fields.weightKg,
            lengthCm: fields.lengthCm,
            widthCm: fields.widthCm,
            heightCm: fields.heightCm,
            handling: fields.handling,
            vehicleClass: fields.vehicleClass,
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
