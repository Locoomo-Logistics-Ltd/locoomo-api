import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DeliveryEventBus } from '../../logistics/application/delivery-event-bus';
import type {
  DeliveryEventListener,
  DeliveryEventNotice,
} from '../../logistics/application/delivery-event-types';
import {
  DeliveryEventType,
  DeliveryLegType,
} from '../../logistics/application/delivery-vocabulary';
import { NodesService } from '../../nodes/application/nodes.service';
import { OrdersService } from '../../orders/application/orders.service';
import { ReturnNotificationService } from './return-notification.service';
import { RiderCapacityService } from '../../riders/application/rider-capacity.service';

// Moves the order (and the capacity counters around it) whenever a
// delivery leg moves — for every courier alike. In-house handovers and,
// from phase 3, external couriers' webhooks both arrive here through
// logistics' DeliveryEventBus, inside the transaction that moved the leg.
@Injectable()
export class DeliveryProgressListener
  implements DeliveryEventListener, OnModuleInit
{
  private readonly logger = new Logger(DeliveryProgressListener.name);

  constructor(
    private readonly bus: DeliveryEventBus,
    private readonly ordersService: OrdersService,
    private readonly nodesService: NodesService,
    private readonly riderCapacityService: RiderCapacityService,
    private readonly returnNotificationService: ReturnNotificationService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this);
  }

  async onDeliveryEvent(
    notice: DeliveryEventNotice,
    manager: EntityManager,
  ): Promise<void> {
    // Two kinds of return: the forward courier turning back mid-delivery
    // (same leg: returning → returned, handled below), and a separately
    // booked RETURN leg from the destination shelf (uncollected parcels).
    if (notice.legType === DeliveryLegType.RETURN) {
      return this.onReturnLeg(notice, manager);
    }

    switch (notice.event) {
      case DeliveryEventType.ASSIGNED:
        // In-house riders are Locoomo users and hold a capacity slot (taken
        // by AcceptOrderService); external couriers' riders are not.
        if (notice.courierUserId) {
          await this.ordersService.assignRider(
            notice.orderId,
            notice.courierUserId,
            manager,
          );
        } else {
          await this.ordersService.markCourierAssigned(
            notice.orderId,
            notice.providerKey,
            manager,
          );
        }
        return;

      case DeliveryEventType.PICKED_UP: {
        // The parcel has left the origin counter — its slot there frees up.
        const order = await this.ordersService.markPickedUpByRider(
          notice.orderId,
          manager,
        );
        await this.nodesService.releaseCapacitySlot(
          order.originNodeId,
          manager,
        );
        return;
      }

      case DeliveryEventType.DELIVERED:
        await this.ordersService.markArrivedAtDestination(
          notice.orderId,
          manager,
        );
        if (notice.courierUserId) {
          await this.riderCapacityService.releaseDeliverySlot(
            notice.courierUserId,
            manager,
          );
        }
        return;

      case DeliveryEventType.ATTEMPT_FAILED:
        // Courier keeps the parcel and retries; nothing changes for the
        // order. (Surcharges are recorded on the leg.)
        return;

      case DeliveryEventType.RELEASED:
      case DeliveryEventType.CANCELLED: {
        // Before pickup only (a leg can't be cancelled later). If a courier
        // had been assigned the order goes back to waiting; logistics then
        // routes it to the next courier. A leg cancelled before anyone was
        // assigned leaves the order as it is.
        const [order] = await manager.query<{ status: string }[]>(
          `SELECT status FROM orders WHERE id = $1`,
          [notice.orderId],
        );
        if (order?.status === 'rider_assigned') {
          await this.ordersService.markCourierReleased(
            notice.orderId,
            manager,
            {
              providerKey: notice.providerKey,
              event: notice.event,
              reason: notice.reason,
            },
          );
        }
        return;
      }

      case DeliveryEventType.RETURNING: {
        // The courier couldn't complete the delivery and is bringing the
        // parcel back to the origin Node; sender and receiver are told.
        const order = await this.ordersService.markReturning(
          notice.orderId,
          manager,
          { providerKey: notice.providerKey, reason: notice.reason },
        );
        await this.returnNotificationService.enqueueReturnStarted(
          order,
          manager,
        );
        return;
      }

      case DeliveryEventType.RETURNED: {
        // Back on the origin counter — it occupies a slot there again until
        // the sender collects it.
        const order = await this.ordersService.markReturnedToOrigin(
          notice.orderId,
          manager,
        );
        await this.nodesService.holdReturnedParcel(order.originNodeId, manager);
        if (notice.courierUserId) {
          await this.riderCapacityService.releaseDeliverySlot(
            notice.courierUserId,
            manager,
          );
        }
        return;
      }

      default:
        // Every event type is handled above; this only guards against a new
        // one being added to the vocabulary without a case here.
        this.logger.warn(
          `Unhandled delivery event ${String(notice.event)} for order ${notice.orderId}`,
        );
    }
  }

  // A courier bringing an uncollected parcel from the destination shelf
  // back to the origin Node (CollectionWindowService books the leg). The
  // order is RETURN_INITIATED until pickup.
  private async onReturnLeg(
    notice: DeliveryEventNotice,
    manager: EntityManager,
  ): Promise<void> {
    switch (notice.event) {
      case DeliveryEventType.ASSIGNED:
        // In-house riders already hold a capacity slot (AcceptOrderService).
        await this.ordersService.assignReturnCourier(
          notice.orderId,
          {
            riderId: notice.courierUserId ?? null,
            providerKey: notice.providerKey,
          },
          manager,
        );
        return;

      case DeliveryEventType.PICKED_UP:
        // Off the destination shelf.
        await this.ordersService.markReturnPickedUp(notice.orderId, manager);
        return;

      case DeliveryEventType.DELIVERED: {
        // Back on the origin counter, waiting for the sender (return intake).
        const order = await this.ordersService.markReturnedToOrigin(
          notice.orderId,
          manager,
        );
        await this.nodesService.holdReturnedParcel(order.originNodeId, manager);
        if (notice.courierUserId) {
          await this.riderCapacityService.releaseDeliverySlot(
            notice.courierUserId,
            manager,
          );
        }
        return;
      }

      case DeliveryEventType.RELEASED:
      case DeliveryEventType.CANCELLED:
        // Before pickup: the parcel is still on the destination shelf;
        // logistics routes the return to the next courier.
        await this.ordersService.releaseReturnCourier(notice.orderId, manager, {
          providerKey: notice.providerKey,
          event: notice.event,
          reason: notice.reason,
        });
        return;

      case DeliveryEventType.ATTEMPT_FAILED:
        return;

      default:
        // A courier failing the return trip itself (RETURNING/RETURNED on
        // a return leg) needs a person: ops sees the leg in the admin
        // deliveries list.
        this.logger.error(
          `Return leg ${notice.legId} for order ${notice.orderId} reported ${String(notice.event)}; needs ops follow-up`,
        );
    }
  }
}
