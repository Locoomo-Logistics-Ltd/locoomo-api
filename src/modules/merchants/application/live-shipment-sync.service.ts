import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SenderContactService } from '../../handoffs/application/sender-contact.service';
import {
  OrderStatusChanged,
  OrderStatusEventBus,
  OrderStatusListener,
} from '../../orders/application/order-status-event-bus';
import {
  canTransition,
  ExceptionType,
  ReturnReason,
  ShipmentStatus,
} from '../domain/shipment';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import { ShipmentEventsService } from './shipment-events.service';
import { WalletService } from './wallet.service';

const S = ShipmentStatus;

// Order status → merchant-facing status (plan §6.2). Unlisted order
// statuses (rider_assigned, arrived_at_destination, returned_to_origin)
// don't change what the merchant sees.
const MIRROR: Readonly<Record<string, ShipmentStatus>> = {
  parcel_received_at_origin: S.RECEIVED,
  in_transit: S.IN_TRANSIT,
  ready_for_collection: S.READY_FOR_COLLECTION,
  completed: S.COLLECTED,
  return_initiated: S.RETURNING,
  return_in_transit: S.RETURNING,
  ready_for_sender_collection: S.RETURN_READY,
  return_completed: S.RETURNED,
  cancelled: S.CANCELLED,
  refused: S.REFUSED,
  exception: S.EXCEPTION,
};

interface OrderFacts {
  returnReason: string | null;
  collectionDeadlineAt: Date | null;
  collectedAt: Date | null;
  collectionMethod: 'code' | 'id_check' | null;
  collectorName: string | null;
  refusal: { reason?: string } | null;
  exception: { type?: ExceptionType } | null;
}

// Keeps live shipments in step with their orders (plan E5): every order
// status change is mirrored onto the shipment inside the same transaction,
// which records the shipment event, sends the webhook, and moves the money
// (charge at drop-off, release when it ends before drop-off). Merchant-
// initiated changes update the shipment first, so the mirror finds it
// already there and does nothing.
@Injectable()
export class LiveShipmentSyncService
  implements OrderStatusListener, OnModuleInit
{
  private readonly logger = new Logger(LiveShipmentSyncService.name);

  constructor(
    private readonly bus: OrderStatusEventBus,
    private readonly events: ShipmentEventsService,
    private readonly wallet: WalletService,
    private readonly senderContacts: SenderContactService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this);
    // Return, refusal and lost/damaged emails for merchant orders go to the
    // merchant's contact email (handoffs can't import merchants).
    this.senderContacts.register('merchant', async (order, manager) => {
      if (!order.merchantId) {
        return null;
      }
      const [merchant] = await manager.query<
        {
          contactEmail: string | null;
          tradingName: string;
          ownerEmail: string | null;
        }[]
      >(
        `SELECT m."contactEmail", m."tradingName",
                (SELECT u.email FROM merchant_members mm JOIN users u ON u.id = mm."userId"
                  WHERE mm."merchantId" = m.id AND mm.role = 'owner' LIMIT 1) AS "ownerEmail"
           FROM merchants m WHERE m.id = $1`,
        [order.merchantId],
      );
      const email = merchant?.contactEmail ?? merchant?.ownerEmail ?? null;
      return email ? { email, name: merchant.tradingName } : null;
    });
  }

  async onOrderStatusChanged(
    change: OrderStatusChanged,
    manager: EntityManager,
  ): Promise<void> {
    if (change.source !== 'merchant' || change.fromStatus === null) {
      return;
    }
    const target = MIRROR[change.toStatus];
    if (!target) {
      return;
    }
    const shipment = await manager
      .getRepository(MerchantShipmentEntity)
      .createQueryBuilder('s')
      .where('s."orderId" = :orderId', { orderId: change.orderId })
      .setLock('pessimistic_write')
      .getOne();
    if (!shipment || shipment.status === target) {
      return;
    }
    if (!canTransition(shipment.status, target)) {
      // Expected after a merchant recall (the parcel still travels forward
      // while the shipment already says returning).
      this.logger.debug(
        `Shipment ${shipment.id}: ignoring ${shipment.status} → ${target} (order ${change.toStatus})`,
      );
      return;
    }
    const [facts] = await manager.query<OrderFacts[]>(
      `SELECT "returnReason", "collectionDeadlineAt", "collectedAt",
              "collectionMethod", "collectorName", refusal, exception
         FROM orders WHERE id = $1`,
      [change.orderId],
    );
    shipment.status = target;
    shipment.statusChangedAt = change.occurredAt;
    let nodeName: string | null = null;
    let data: Record<string, unknown> | null = null;

    switch (target) {
      case S.RECEIVED:
        // Charged at the quoted price. Re-pricing on the measured parcel
        // and the real drop-off Node comes with origin rebind (M4c2).
        shipment.feeState = 'charged';
        shipment.chargedKobo = shipment.quotedKobo;
        await this.wallet.captureHold(
          manager,
          shipment.id,
          shipment.quotedKobo,
          `Shipment ${shipment.trackingCode}`,
        );
        nodeName = shipment.origin.nodeName;
        break;
      case S.IN_TRANSIT:
        nodeName = shipment.origin.nodeName;
        break;
      case S.READY_FOR_COLLECTION:
        shipment.collectionDeadline = facts.collectionDeadlineAt;
        nodeName = shipment.destination.nodeName;
        break;
      case S.COLLECTED:
        shipment.collectedAt = facts.collectedAt ?? change.occurredAt;
        shipment.collectionMethod = facts.collectionMethod ?? 'code';
        shipment.collectorName = facts.collectorName;
        nodeName = shipment.destination.nodeName;
        break;
      case S.RETURNING: {
        const reason = (facts.returnReason ??
          'delivery_failed') as ReturnReason;
        shipment.returnInfo = { reason, readyForCollectionAt: null };
        data = { reason };
        break;
      }
      case S.RETURN_READY:
        shipment.returnInfo = {
          reason: shipment.returnInfo?.reason ?? 'not_collected',
          readyForCollectionAt: change.occurredAt.toISOString(),
        };
        nodeName = shipment.origin.nodeName;
        break;
      case S.RETURNED:
        nodeName = shipment.origin.nodeName;
        break;
      case S.CANCELLED:
        shipment.feeState = 'released';
        await this.wallet.releaseHold(manager, shipment.id);
        break;
      case S.REFUSED:
        shipment.feeState = 'released';
        await this.wallet.releaseHold(manager, shipment.id);
        nodeName = shipment.origin.nodeName;
        data = { reason: facts.refusal?.reason ?? null };
        break;
      case S.EXCEPTION: {
        const type = facts.exception?.type ?? 'lost';
        shipment.exceptionInfo = {
          type,
          reportedAt: change.occurredAt.toISOString(),
          claimId: null,
        };
        data = { type };
        break;
      }
      default:
        break;
    }
    await this.events.apply(manager, shipment, target, { nodeName, data });
  }
}
