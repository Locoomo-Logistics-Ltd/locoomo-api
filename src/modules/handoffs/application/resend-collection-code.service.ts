import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxService } from '../../notifications/application/outbox.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { HandoffCodeIssued } from '../domain/handoff-code-issued';
import { OrderNotReadyForCollectionException } from '../domain/exceptions/order-not-ready-for-collection.exception';
import { HandoffCodeIssuerService } from './handoff-code-issuer.service';
import { OrderLookupService } from './order-lookup.service';

const COLLECTION_CODE_TTL_MINUTES = 60;

interface OrderForResend {
  status: string;
  receiverEmail: string;
  parcelDescription: string;
}

// Receiver-facing collection codes are never returned via this API (see
// HandoffCodeResponseDto's opposite reasoning for rider codes) — the
// receiver has no account/session to receive an API response on, so the
// only channel is email, and the only person who can trigger a resend is
// the destination operator standing at the counter with them.
@Injectable()
export class ResendCollectionCodeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orderLookupService: OrderLookupService,
    private readonly handoffCodeIssuerService: HandoffCodeIssuerService,
    private readonly outboxService: OutboxService,
  ) {}

  async resend(
    orderId: string,
    operatorUserId: string,
  ): Promise<Pick<HandoffCodeIssued, 'expiresAt'>> {
    await this.orderLookupService.assertDestinationNodeOwnership(
      orderId,
      operatorUserId,
    );

    const rows = await this.dataSource.query<OrderForResend[]>(
      `SELECT status, "receiverEmail", "parcelDescription" FROM orders WHERE id = $1`,
      [orderId],
    );
    const order = rows[0];
    // 'ready_for_collection' is orders' own OrderStatus value, hardcoded
    // here rather than importing the enum — same precedent as
    // NodeOperatorQueryService's cross-module raw-SQL reads.
    if (!order || order.status !== 'ready_for_collection') {
      throw new OrderNotReadyForCollectionException(orderId);
    }

    const issued = await this.dataSource.transaction(async (manager) => {
      const result = await this.handoffCodeIssuerService.issue(
        manager,
        orderId,
        HandoffCodeType.RECEIVER_COLLECTION,
        null,
        COLLECTION_CODE_TTL_MINUTES,
      );
      await this.outboxService.enqueueEmail(
        {
          to: order.receiverEmail,
          subject: 'Your new Locoomo collection code',
          text:
            `Here's a new collection code for your parcel (${order.parcelDescription}): ${result.code}\n` +
            `The code expires in ${COLLECTION_CODE_TTL_MINUTES} minutes.`,
          html:
            `<p>Here's a new collection code for your parcel (${order.parcelDescription}): ` +
            `<strong>${result.code}</strong></p>` +
            `<p>The code expires in ${COLLECTION_CODE_TTL_MINUTES} minutes.</p>`,
        },
        manager,
      );
      return result;
    });

    return { expiresAt: issued.expiresAt };
  }
}
