import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { OrdersService } from '../../orders/application/orders.service';
import { PublicHolidayService } from '../../orders/application/public-holiday.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { OrderTransitionResult } from '../domain/order-transition-result';
import { HandoffCodeIssuerService } from './handoff-code-issuer.service';
import { OrderLookupService } from './order-lookup.service';
import { ReturnNotificationService } from './return-notification.service';

const IDEMPOTENCY_SCOPE = 'handoffs.return-intake';
export const SENDER_COLLECTION_CODE_TTL_MINUTES = 60;
// Merchants collect returns on their own schedule: the code lasts the free
// storage period (D20) rather than an hour.
export const MERCHANT_RETURN_CODE_WORKING_DAYS = 10;

// When a sender's collection code stops working.
export async function senderCodeExpiry(
  source: string | null | undefined,
  holidays: PublicHolidayService,
  now = new Date(),
): Promise<Date> {
  return source === 'merchant'
    ? holidays.addWorkingDays(now, MERCHANT_RETURN_CODE_WORKING_DAYS)
    : new Date(now.getTime() + SENDER_COLLECTION_CODE_TTL_MINUTES * 60_000);
}

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
    private readonly holidays: PublicHolidayService,
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
            const expiresAt = await senderCodeExpiry(
              order.source,
              this.holidays,
            );
            const issued = await this.handoffCodeIssuerService.issueUntil(
              manager,
              orderId,
              HandoffCodeType.SENDER_COLLECTION,
              null,
              expiresAt,
            );
            await this.returnNotificationService.enqueueSenderCollectionCode(
              order,
              issued.code,
              expiresAt,
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
