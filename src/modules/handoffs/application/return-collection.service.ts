import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
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

  // A merchant return batch (M4f2): the batch code was already checked by
  // the merchants module, so hand this parcel back without its own code.
  // Its outstanding per-parcel code stops working. Returns false when the
  // parcel isn't waiting for its sender any more (collected separately).
  async handBackInBatch(
    manager: EntityManager,
    orderId: string,
    payload: { identityConfirmed: boolean; returnBatchId: string },
  ): Promise<boolean> {
    const [row] = await manager.query<{ status: string }[]>(
      `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (row?.status !== 'ready_for_sender_collection') {
      return false;
    }
    const order = await this.ordersService.markCollectedBySender(
      orderId,
      manager,
      payload,
    );
    await this.nodesService.releaseCapacitySlot(order.originNodeId, manager);
    await manager.query(
      `UPDATE handoff_codes SET "usedAt" = now()
        WHERE "orderId" = $1 AND type = $2 AND "usedAt" IS NULL`,
      [orderId, HandoffCodeType.SENDER_COLLECTION],
    );
    return true;
  }
}
