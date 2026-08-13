import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { OrdersService } from '../../orders/application/orders.service';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { OrderLookupService } from './order-lookup.service';

const IDEMPOTENCY_SCOPE = 'handoffs.drop-off';

@Injectable()
export class ConfirmDropOffService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async confirm(
    orderId: string,
    operatorUserId: string,
  ): Promise<OrderTransitionResult> {
    // Ownership check first, outside the transaction — a wrong-Node request
    // should 404 before it ever touches the idempotency table or attempts a
    // transition.
    await this.orderLookupService.assertOriginNodeOwnership(
      orderId,
      operatorUserId,
    );

    const { result, alreadyProcessed } = await this.dataSource.transaction(
      (manager) =>
        this.idempotencyService.withIdempotency(
          IDEMPOTENCY_SCOPE,
          orderId,
          manager,
          () => this.ordersService.markReceivedAtOrigin(orderId, manager),
        ),
    );

    if (alreadyProcessed) {
      // A duplicate idempotency key means the insert above hit a unique
      // violation — which, per Postgres, poisons the rest of that
      // transaction even though IdempotencyService caught it. Re-reading
      // current state has to happen as its own fresh query, outside that
      // transaction, not chained onto it.
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
