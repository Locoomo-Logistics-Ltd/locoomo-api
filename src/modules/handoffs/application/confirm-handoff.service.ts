import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { DeliveryEventsService } from '../../logistics/application/delivery-events.service';
import { DeliveryEventType } from '../../logistics/application/delivery-vocabulary';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { HandoffCodeValidatorService } from './handoff-code-validator.service';
import { OrderLookupService } from './order-lookup.service';

@Injectable()
export class ConfirmHandoffService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly idempotencyService: IdempotencyService,
    private readonly handoffCodeValidatorService: HandoffCodeValidatorService,
    private readonly deliveryEventsService: DeliveryEventsService,
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
    // A return job (uncollected parcel) runs the other way: the rider
    // collects at the destination Node and hands over at the origin.
    const [current] = await this.dataSource.query<{ status: string }[]>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    const isReturn =
      current?.status === 'return_initiated' ||
      current?.status === 'return_in_transit';
    const atOrigin = (type === HandoffCodeType.RIDER_PICKUP) !== isReturn;
    if (atOrigin) {
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

    // Per direction: a returned order has its own pickup and arrival, and
    // they must not be mistaken for replays of the forward ones.
    const scope = `handoffs.confirm-handoff.${type}${isReturn ? '.return' : ''}`;
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
            // The code proves the handover; the order (and the Node/rider
            // capacity counters) then move via DeliveryProgressListener —
            // the same path an external courier's update takes.
            await this.deliveryEventsService.recordInHouseHandover(
              orderId,
              type === HandoffCodeType.RIDER_PICKUP
                ? DeliveryEventType.PICKED_UP
                : DeliveryEventType.DELIVERED,
              manager,
            );
            const [order] = await manager.query<OrderTransitionResult[]>(
              `SELECT id, "trackingCode", status, "originNodeId", "destinationNodeId",
                      "shelfNumber"
                 FROM orders WHERE id = $1`,
              [orderId],
            );
            return order;
          },
        ),
    );

    if (alreadyProcessed) {
      // Same transaction-poisoning reasoning as ConfirmDropOffService: the
      // idempotency insert's unique violation leaves the transaction
      // aborted even though we caught it, so the re-read has to be a fresh
      // query outside it, not chained onto the same manager.
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
