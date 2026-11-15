import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { OrdersService } from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { HandoffCodeIssuerService } from './handoff-code-issuer.service';
import { OrderLookupService } from './order-lookup.service';
import { ParcelRecallService } from './parcel-recall.service';
import { ReceiverNotificationService } from './receiver-notification.service';

const IDEMPOTENCY_SCOPE = 'handoffs.confirm-intake';

// The receiver's code lasts the whole collection window (D15, plan §5.4):
// 7 working days, then an uncollected parcel goes back to the sender
// (CollectionWindowService). This resolves E6.

// Destination-side equivalent of ConfirmDropOffService: a Node operator
// confirming the parcel physically arrived at their counter (the rider
// handoff already moved it to ARRIVED_AT_DESTINATION via
// ConfirmHandoffService). Unlike drop-off, this step also mints the
// receiver's collection code and emails it, atomically with the status
// transition — decision #10, transactional outbox.
@Injectable()
export class ConfirmIntakeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly idempotencyService: IdempotencyService,
    private readonly handoffCodeIssuerService: HandoffCodeIssuerService,
    private readonly receiverNotificationService: ReceiverNotificationService,
    private readonly parcelRecall: ParcelRecallService,
  ) {}

  async confirm(
    orderId: string,
    operatorUserId: string,
  ): Promise<OrderTransitionResult> {
    await this.orderLookupService.assertDestinationNodeOwnership(
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
            const order = await this.ordersService.markReadyForCollection(
              orderId,
              manager,
            );
            // Recalled by the merchant while on its way: turn it round now,
            // without ever offering it to the buyer.
            if (order.returnRequestedAt) {
              await this.parcelRecall.returnFromShelf(
                orderId,
                'merchant_request',
                manager,
              );
              // Report what the counter must do now (status
              // return_initiated: keep it for the return courier).
              const [current] = await manager.query<OrderTransitionResult[]>(
                `SELECT id, "trackingCode", status, "originNodeId",
                        "destinationNodeId", "shelfNumber"
                   FROM orders WHERE id = $1`,
                [orderId],
              );
              return current;
            }
            const deadline = order.collectionDeadlineAt!;
            const issued = await this.handoffCodeIssuerService.issueUntil(
              manager,
              orderId,
              HandoffCodeType.RECEIVER_COLLECTION,
              null,
              deadline,
            );
            await this.receiverNotificationService.enqueueReadyForCollection(
              order,
              issued.code,
              deadline,
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
