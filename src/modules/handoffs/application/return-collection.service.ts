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

const IDEMPOTENCY_SCOPE = 'handoffs.return-collect';

// The sender collects their returned parcel at the origin Node — mirror of
// ConfirmCollectionService. The order ends here (RETURN_COMPLETED), with no
// revenue split: it was never delivered. The parcel leaves the shelf and
// the Node's capacity slot (re-taken when it came back) is freed.
@Injectable()
export class ReturnCollectionService {
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
    code: string,
    identityConfirmed: boolean,
  ): Promise<OrderTransitionResult> {
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
          async () => {
            await this.handoffCodeValidatorService.validate(
              manager,
              orderId,
              HandoffCodeType.SENDER_COLLECTION,
              code,
            );
            const order = await this.ordersService.markCollectedBySender(
              orderId,
              manager,
              { identityConfirmed },
            );
            await this.nodesService.releaseCapacitySlot(
              order.originNodeId,
              manager,
            );
            return order;
          },
        ),
    );

    if (alreadyProcessed) {
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
