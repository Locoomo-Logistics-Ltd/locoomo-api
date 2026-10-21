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
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this);
  }

  async onDeliveryEvent(
    notice: DeliveryEventNotice,
    manager: EntityManager,
  ): Promise<void> {
    if (notice.legType !== DeliveryLegType.FORWARD) {
      this.logger.warn(
        `Ignoring ${notice.event} on ${notice.legType} leg ${notice.legId} — returns arrive in phase 5`,
      );
      return;
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

      default:
        // released / cancelled / returning / returned need order states
        // that arrive with external couriers (phase 3) and returns
        // (phase 5).
        this.logger.warn(
          `Unhandled delivery event ${notice.event} for order ${notice.orderId}`,
        );
    }
  }
}
