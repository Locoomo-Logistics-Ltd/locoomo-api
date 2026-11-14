import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DeliveryDispatchService } from '../../logistics/application/delivery-dispatch.service';
import { DeliveryLegType } from '../../logistics/application/delivery-vocabulary';
import { OrdersService } from '../../orders/application/orders.service';
import { HandoffCodeType } from '../domain/handoff-code-type.enum';
import { HandoffCodeIssuerService } from './handoff-code-issuer.service';
import { ReceiverNotificationService } from './receiver-notification.service';
import { ReturnNotificationService } from './return-notification.service';

export type ShelfReturnReason = 'not_collected' | 'merchant_request';

// Sends a parcel on a destination shelf back to its sender, and reissues a
// buyer's collection code. One implementation for the collection-window job,
// the destination turning round a recalled parcel, and merchant requests
// (exported: merchants call it without importing handoffs' internals).
@Injectable()
export class ParcelRecallService {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly deliveryDispatchService: DeliveryDispatchService,
    private readonly handoffCodeIssuerService: HandoffCodeIssuerService,
    private readonly receiverNotificationService: ReceiverNotificationService,
    private readonly returnNotificationService: ReturnNotificationService,
  ) {}

  // ready_for_collection → return_initiated: the receiver's code is voided,
  // a return courier is booked from the destination, the sender is told.
  // Throws IllegalOrderTransition if it isn't on the shelf.
  async returnFromShelf(
    orderId: string,
    reason: ShelfReturnReason,
    manager: EntityManager,
  ): Promise<void> {
    const order = await this.ordersService.markUncollected(
      orderId,
      manager,
      reason,
    );
    await manager.query(
      `DELETE FROM handoff_codes
        WHERE "orderId" = $1 AND type = $2 AND "usedAt" IS NULL`,
      [orderId, HandoffCodeType.RECEIVER_COLLECTION],
    );
    await this.deliveryDispatchService.dispatch(
      orderId,
      manager,
      DeliveryLegType.RETURN,
    );
    await this.returnNotificationService.enqueueReturnStarted(
      order,
      manager,
      reason,
    );
  }

  // New receiver contact while the parcel is on the shelf: a fresh code
  // (same deadline) goes to the new contact. No-op otherwise.
  async reissueReceiverCode(
    orderId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    const [order] = await manager.query<
      {
        status: string;
        trackingCode: string;
        receiverEmail: string | null;
        receiverPhone: string;
        parcelDescription: string;
        destinationNodeId: string;
        collectionDeadlineAt: Date | null;
      }[]
    >(
      `SELECT status, "trackingCode", "receiverEmail", "receiverPhone",
              "parcelDescription", "destinationNodeId", "collectionDeadlineAt"
         FROM orders WHERE id = $1`,
      [orderId],
    );
    if (
      !order ||
      order.status !== 'ready_for_collection' ||
      !order.collectionDeadlineAt
    ) {
      return false;
    }
    const issued = await this.handoffCodeIssuerService.issueUntil(
      manager,
      orderId,
      HandoffCodeType.RECEIVER_COLLECTION,
      null,
      order.collectionDeadlineAt,
    );
    await this.receiverNotificationService.enqueueNewCollectionCode(
      order,
      issued.code,
      order.collectionDeadlineAt,
      manager,
    );
    return true;
  }
}
