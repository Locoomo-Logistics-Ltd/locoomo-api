import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { DeliveryDispatchService } from '../../logistics/application/delivery-dispatch.service';
import { NodesService } from '../../nodes/application/nodes.service';
import {
  MeasuredParcel,
  OrdersService,
} from '../../orders/application/orders.service';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { BagService } from './bag.service';
import { OrderLookupService } from './order-lookup.service';
import { RerouteService } from './reroute.service';
import { ReceiverNotificationService } from './receiver-notification.service';

const IDEMPOTENCY_SCOPE = 'handoffs.drop-off';

@Injectable()
export class ConfirmDropOffService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly idempotencyService: IdempotencyService,
    private readonly receiverNotificationService: ReceiverNotificationService,
    private readonly deliveryDispatchService: DeliveryDispatchService,
    private readonly nodesService: NodesService,
    private readonly bags: BagService,
    private readonly reroutes: RerouteService,
  ) {}

  async confirm(
    orderId: string,
    operatorUserId: string,
    input: { nodeId?: string; measured?: MeasuredParcel } = {},
  ): Promise<OrderTransitionResult> {
    // Which Node is receiving it, outside the transaction: a wrong-Node
    // request 404s before touching the idempotency table. A merchant
    // parcel brought to another Node is re-homed there (plan E4).
    const intakeNode = await this.orderLookupService.resolveDropOffNode(
      orderId,
      operatorUserId,
      input.nodeId,
    );
    const measured =
      input.measured && Object.keys(input.measured).length > 0
        ? input.measured
        : null;

    const { result, alreadyProcessed } = await this.dataSource.transaction(
      (manager) =>
        this.idempotencyService.withIdempotency(
          IDEMPOTENCY_SCOPE,
          orderId,
          manager,
          async () => {
            const order = await this.ordersService.markReceivedAtOrigin(
              orderId,
              manager,
              {
                ...(intakeNode.rebind && { originNodeId: intakeNode.nodeId }),
                measured,
              },
            );
            // Consumer orders reserved their origin slot at checkout.
            // Merchant parcels take one now and are never refused for
            // space at the counter (plan §5.2): the Node may go over
            // capacity and simply stops being offered until it frees up.
            if (order.source === 'merchant') {
              await this.nodesService.holdReturnedParcel(
                order.originNodeId,
                manager,
              );
            }
            await this.receiverNotificationService.enqueueOnItsWay(
              order,
              manager,
            );
            // At a hub, a merchant parcel goes into the bag for its
            // destination and travels with it (M5b). Otherwise hand it to a
            // courier straight away — whichever one routing picks.
            // A merchant parcel whose destination is full or closed waits
            // here for ops to pick another (M5c reroute queue).
            if (
              !(await this.reroutes.holdIfDestinationBlocked(order, manager))
            ) {
              await this.bags.sendOnward(order, manager);
            }
            return order;
          },
        ),
    );

    if (alreadyProcessed) {
      // A duplicate idempotency key means the insert above hit a unique
      // violation — which, per Postgres, poisons the rest of that
      // transaction even though IdempotencyService caught it. Re-reading
      // current state has to happen as its own fresh query, outside that
      // transaction, not chained onto it.
      const [row] = await this.dataSource.query<OrderTransitionResult[]>(
        `SELECT id, "trackingCode", status, "originNodeId", "destinationNodeId",
                "shelfNumber"
           FROM orders WHERE id = $1`,
        [orderId],
      );
      return row;
    }

    return result as OrderTransitionResult;
  }
}
