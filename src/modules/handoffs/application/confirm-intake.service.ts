import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { OutboxService } from '../../notifications/application/outbox.service';
import { OrdersService } from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { HandoffCodeIssuerService } from './handoff-code-issuer.service';
import { OrderLookupService } from './order-lookup.service';

const IDEMPOTENCY_SCOPE = 'handoffs.confirm-intake';

// The receiver has no account to check a status page with (decision #7),
// so a 60-minute window gives them time to notice the email without the
// operator having to babysit the counter — ResendCollectionCodeService
// covers the case where that isn't enough. How long an order can sit
// ARRIVED_AT_DESTINATION/READY_FOR_COLLECTION before it's treated as
// abandoned is E6, still unresolved — not decided here.
const COLLECTION_CODE_TTL_MINUTES = 60;

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
    private readonly outboxService: OutboxService,
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
            const issued = await this.handoffCodeIssuerService.issue(
              manager,
              orderId,
              HandoffCodeType.RECEIVER_COLLECTION,
              null,
              COLLECTION_CODE_TTL_MINUTES,
            );
            await this.outboxService.enqueueEmail(
              {
                to: order.receiverEmail,
                subject: 'Your Locoomo parcel is ready for collection',
                text:
                  `Your parcel (${order.parcelDescription}) has arrived and is ready for collection.\n\n` +
                  `Your collection code is: ${issued.code}\n` +
                  `Give this code to the Node operator, along with your name, to collect your parcel. ` +
                  `The code expires in ${COLLECTION_CODE_TTL_MINUTES} minutes.`,
                html:
                  `<p>Your parcel (${order.parcelDescription}) has arrived and is ready for collection.</p>` +
                  `<p>Your collection code is: <strong>${issued.code}</strong></p>` +
                  `<p>Give this code to the Node operator, along with your name, to collect your parcel. ` +
                  `The code expires in ${COLLECTION_CODE_TTL_MINUTES} minutes.</p>`,
              },
              manager,
            );
            return order;
          },
        ),
    );

    if (alreadyProcessed) {
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
