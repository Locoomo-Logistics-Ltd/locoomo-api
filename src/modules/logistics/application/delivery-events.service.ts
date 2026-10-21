import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DeliveryNotClaimableException } from '../domain/exceptions/delivery-not-claimable.exception';
import {
  ACTIVE_LEG_STATUSES,
  DeliveryEventType,
  DeliveryLegStatus,
  DeliveryLegType,
  isTerminal,
  nextLegStatus,
} from '../domain/delivery-leg';
import type { ProviderDeliverySnapshot } from '../domain/ports/logistics-provider.port';
import { DeliveryLegEntity } from '../infrastructure/entities/delivery-leg.entity';
import { DeliveryEventBus } from './delivery-event-bus';
import { IN_HOUSE_PROVIDER_KEY } from './in-house-provider-key';

// The one path by which any courier's progress — an in-house rider's code
// handover, or (phase 3) an external courier's webhook — moves a leg and,
// through DeliveryEventBus, the order. Every method runs inside the
// caller's transaction and locks the leg row.
@Injectable()
export class DeliveryEventsService {
  constructor(private readonly bus: DeliveryEventBus) {}

  // A rider claiming an order from the pool. The order's leg must be the
  // in-house pool's and still unassigned; an order dropped off before legs
  // existed (or put in the pool by hand) gets one on the spot.
  async assignInHouseRider(
    orderId: string,
    riderUserId: string,
    manager: EntityManager,
  ): Promise<void> {
    await this.lockOrder(orderId, manager);
    const leg =
      (await this.lockActiveLeg(orderId, manager)) ??
      (await this.createInHouseLeg(
        orderId,
        DeliveryLegStatus.REQUESTED,
        null,
        manager,
      ));
    if (leg.providerKey !== IN_HOUSE_PROVIDER_KEY) {
      throw new DeliveryNotClaimableException(
        orderId,
        `it's with ${leg.providerKey}`,
      );
    }
    if (leg.status !== DeliveryLegStatus.REQUESTED) {
      throw new DeliveryNotClaimableException(orderId, 'already claimed');
    }

    const [rider] = await manager.query<
      { firstName: string; lastName: string; phone: string | null }[]
    >(`SELECT "firstName", "lastName", phone FROM users WHERE id = $1`, [
      riderUserId,
    ]);
    leg.courierUserId = riderUserId;
    leg.courierName = rider
      ? `${rider.firstName} ${rider.lastName.charAt(0)}.`
      : null;
    leg.courierPhone = rider?.phone ?? null;
    await this.apply(leg, DeliveryEventType.ASSIGNED, manager);
  }

  // An in-house handover confirmed with the rider's code at a counter
  // (pickup at origin, arrival at destination).
  async recordInHouseHandover(
    orderId: string,
    event: DeliveryEventType.PICKED_UP | DeliveryEventType.DELIVERED,
    manager: EntityManager,
  ): Promise<void> {
    await this.lockOrder(orderId, manager);
    let leg = await this.lockActiveLeg(orderId, manager);
    if (!leg) {
      // An order already with a rider before legs existed.
      const [order] = await manager.query<{ riderId: string | null }[]>(
        `SELECT "riderId" FROM orders WHERE id = $1`,
        [orderId],
      );
      leg = await this.createInHouseLeg(
        orderId,
        event === DeliveryEventType.PICKED_UP
          ? DeliveryLegStatus.ASSIGNED
          : DeliveryLegStatus.PICKED_UP,
        order?.riderId ?? null,
        manager,
      );
    }
    if (leg.providerKey !== IN_HOUSE_PROVIDER_KEY) {
      throw new DeliveryNotClaimableException(
        orderId,
        `it's with ${leg.providerKey}, whose courier confirms handovers in their own app`,
      );
    }
    if (!(await this.apply(leg, event, manager))) {
      throw new DeliveryNotClaimableException(
        orderId,
        `the delivery is ${leg.status}`,
      );
    }
  }

  // A provider-reported change (webhook or reconciliation), with the
  // provider's normalised snapshot. Returns false when ignored: unknown
  // delivery, a stale out-of-order update, or an event that doesn't apply
  // in the leg's current state (duplicates) — never an error, since
  // providers redeliver freely.
  async applyProviderEvent(
    providerKey: string,
    externalId: string,
    event: DeliveryEventType,
    snapshot: ProviderDeliverySnapshot | null,
    manager: EntityManager,
  ): Promise<boolean> {
    const leg = await manager
      .getRepository(DeliveryLegEntity)
      .createQueryBuilder('leg')
      .setLock('pessimistic_write')
      .where('leg."providerKey" = :providerKey', { providerKey })
      .andWhere('leg."externalId" = :externalId', { externalId })
      .getOne();
    if (!leg) {
      return false;
    }
    if (
      snapshot?.sequence != null &&
      leg.providerSequence != null &&
      snapshot.sequence <= leg.providerSequence
    ) {
      return false;
    }
    if (snapshot) {
      leg.providerStatus = snapshot.providerStatus;
      leg.providerSequence = snapshot.sequence;
      leg.courierName = snapshot.courier?.name ?? leg.courierName;
      leg.courierPhone = snapshot.courier?.phone ?? leg.courierPhone;
      leg.courierVehicle = snapshot.courier?.vehicle ?? leg.courierVehicle;
      leg.trackingUrl = snapshot.trackingUrl ?? leg.trackingUrl;
      leg.actualKobo = snapshot.actualKobo ?? leg.actualKobo;
      leg.surchargeKobo = snapshot.surchargeKobo ?? leg.surchargeKobo;
      leg.failureReason = snapshot.failureReason ?? leg.failureReason;
    }
    return this.apply(leg, event, manager);
  }

  private async apply(
    leg: DeliveryLegEntity,
    event: DeliveryEventType,
    manager: EntityManager,
  ): Promise<boolean> {
    const next = nextLegStatus(leg.status, event);
    if (!next) {
      return false;
    }
    if (event === DeliveryEventType.RELEASED) {
      leg.courierUserId = null;
      leg.courierName = null;
      leg.courierPhone = null;
      leg.courierVehicle = null;
    }
    leg.status = next;
    if (isTerminal(next)) {
      leg.endedAt = new Date();
    }
    await manager.getRepository(DeliveryLegEntity).save(leg);

    await this.bus.publish(
      {
        orderId: leg.orderId,
        legId: leg.id,
        legType: leg.legType,
        providerKey: leg.providerKey,
        event,
        courierUserId: leg.courierUserId,
      },
      manager,
    );
    return true;
  }

  // Serialises everything that might *create* an order's leg. Locking the
  // leg row alone can't: when there is no leg yet there's nothing to lock,
  // and two riders accepting at once would both insert one — the second
  // tripping the one-active-leg unique index as a 500 instead of losing
  // cleanly with a 409.
  private async lockOrder(
    orderId: string,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [
      orderId,
    ]);
  }

  private lockActiveLeg(
    orderId: string,
    manager: EntityManager,
  ): Promise<DeliveryLegEntity | null> {
    return manager
      .getRepository(DeliveryLegEntity)
      .createQueryBuilder('leg')
      .setLock('pessimistic_write')
      .where('leg."orderId" = :orderId', { orderId })
      .andWhere('leg.status IN (:...active)', { active: ACTIVE_LEG_STATUSES })
      .getOne();
  }

  private async createInHouseLeg(
    orderId: string,
    status: DeliveryLegStatus,
    courierUserId: string | null,
    manager: EntityManager,
  ): Promise<DeliveryLegEntity> {
    const legs = manager.getRepository(DeliveryLegEntity);
    const [{ count }] = await manager.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM delivery_legs WHERE "orderId" = $1`,
      [orderId],
    );
    return legs.save(
      legs.create({
        orderId,
        legType: DeliveryLegType.FORWARD,
        providerKey: IN_HOUSE_PROVIDER_KEY,
        status,
        attemptNumber: count + 1,
        courierUserId,
      }),
    );
  }
}
