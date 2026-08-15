import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { NodesService } from '../../nodes/application/nodes.service';
import { OrdersService } from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { HandoffCodeValidatorService } from './handoff-code-validator.service';
import { OrderLookupService } from './order-lookup.service';

@Injectable()
export class ConfirmHandoffService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly idempotencyService: IdempotencyService,
    private readonly handoffCodeValidatorService: HandoffCodeValidatorService,
    private readonly nodesService: NodesService,
  ) {}

  async confirm(
    orderId: string,
    operatorUserId: string,
    type: HandoffCodeType.RIDER_PICKUP | HandoffCodeType.RIDER_ARRIVAL,
    code: string,
  ): Promise<OrderTransitionResult> {
    // Ownership first, outside the transaction — same reasoning as
    // drop-off: immutable data, and a wrong-Node request should 404 before
    // it ever touches the idempotency table.
    if (type === HandoffCodeType.RIDER_PICKUP) {
      await this.orderLookupService.assertOriginNodeOwnership(
        orderId,
        operatorUserId,
      );
    } else {
      await this.orderLookupService.assertDestinationNodeOwnership(
        orderId,
        operatorUserId,
      );
    }

    const scope = `handoffs.confirm-handoff.${type}`;
    const { result, alreadyProcessed } = await this.dataSource.transaction(
      (manager) =>
        this.idempotencyService.withIdempotency(
          scope,
          orderId,
          manager,
          async () => {
            await this.handoffCodeValidatorService.validate(
              manager,
              orderId,
              type,
              code,
            );
            if (type === HandoffCodeType.RIDER_PICKUP) {
              const order = await this.ordersService.markPickedUpByRider(
                orderId,
                manager,
              );
              // The parcel physically leaves the origin Node's premises at
              // this exact moment — release the booking-time capacity hold
              // (decision #6) inline, same transaction, so the origin Node
              // doesn't stay artificially full for every order that has
              // long since moved on. Strict-consistency effect, per
              // decision #4.
              await this.nodesService.releaseCapacitySlot(
                order.originNodeId,
                manager,
              );
              return order;
            }
            return this.ordersService.markArrivedAtDestination(
              orderId,
              manager,
            );
          },
        ),
    );

    if (alreadyProcessed) {
      // Same transaction-poisoning reasoning as ConfirmDropOffService: the
      // idempotency insert's unique violation leaves the transaction
      // aborted even though we caught it, so the re-read has to be a fresh
      // query outside it, not chained onto the same manager.
      const [row] = await this.dataSource.query<OrderTransitionResult[]>(
        `SELECT id, "trackingCode", status, "originNodeId", "destinationNodeId"
           FROM orders WHERE id = $1`,
        [orderId],
      );
      return row;
    }

    return result as OrderTransitionResult;
  }
}
