import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { OrdersService } from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { HandoffCodeIssuerService } from './handoff-code-issuer.service';
import { OrderLookupService } from './order-lookup.service';
import { ReturnNotificationService } from './return-notification.service';

const IDEMPOTENCY_SCOPE = 'handoffs.return-intake';
export const SENDER_COLLECTION_CODE_TTL_MINUTES = 60;

// Origin-side mirror of ConfirmIntakeService, for a returned parcel: staff
// shelve it (shelf number) and the *sender* is emailed a collection code.
@Injectable()
export class ReturnIntakeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly ordersService: OrdersService,
    private readonly idempotencyService: IdempotencyService,
    private readonly handoffCodeIssuerService: HandoffCodeIssuerService,
    private readonly returnNotificationService: ReturnNotificationService,
  ) {}

  async confirm(
    orderId: string,
    operatorUserId: string,
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
            const order = await this.ordersService.markReadyForSenderCollection(
              orderId,
              manager,
            );
            const issued = await this.handoffCodeIssuerService.issue(
              manager,
              orderId,
              HandoffCodeType.SENDER_COLLECTION,
              null,
              SENDER_COLLECTION_CODE_TTL_MINUTES,
            );
            await this.returnNotificationService.enqueueSenderCollectionCode(
              order,
              issued.code,
              SENDER_COLLECTION_CODE_TTL_MINUTES,
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
