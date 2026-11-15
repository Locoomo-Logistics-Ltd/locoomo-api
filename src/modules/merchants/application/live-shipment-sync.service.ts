import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ReceiverCodeRelay,
  RelayedCode,
} from '../../handoffs/application/receiver-code-relay';
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
import { OrdersService } from '../../orders/application/orders.service';
import { MerchantShipmentService } from './merchant-shipment.service';
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
  originNodeId: string;
  measured: MeasuredParcel | null;
  notifyReceiver: string;
}

// What the origin counter measured (orders.measured).
interface MeasuredParcel {
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  size?: string;
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
    private readonly shipments: MerchantShipmentService,
    private readonly orders: OrdersService,
    private readonly codeRelay: ReceiverCodeRelay,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this);
    this.codeRelay.register({
      relay: (code, manager) => this.relayCode(code, manager),
    });
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
              "collectionMethod", "collectorName", refusal, exception,
              "originNodeId", measured, "notifyReceiver"
         FROM orders WHERE id = $1`,
      [change.orderId],
    );
    if (target === S.RECEIVED) {
      await this.receive(manager, shipment, facts, change);
      return;
    }
    // Relayed parcels become ready when their code is issued (relayCode),
    // so the webhook carries it.
    if (
      target === S.READY_FOR_COLLECTION &&
      facts.notifyReceiver !== 'locoomo'
    ) {
      return;
    }
    shipment.status = target;
    shipment.statusChangedAt = change.occurredAt;
    let nodeName: string | null = null;
    let data: Record<string, unknown> | null = null;

    switch (target) {
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

  // Dropped off (plan E2, E4, D14): charge the held quote, then re-price
  // from where it was really dropped and what the counter measured, and
  // charge or refund the difference. Re-pricing never blocks the drop-off:
  // if it can't be done, the quote stands and ops see why on the order.
  private async receive(
    manager: EntityManager,
    shipment: MerchantShipmentEntity,
    facts: OrderFacts,
    change: OrderStatusChanged,
  ): Promise<void> {
    const previousOrigin = shipment.origin;
    const reHomed = facts.originNodeId !== previousOrigin.nodeId;
    if (reHomed) {
      const [node] = await manager.query<
        { name: string; address: string; city: string; state: string }[]
      >(`SELECT name, address, city, state FROM nodes WHERE id = $1`, [
        facts.originNodeId,
      ]);
      shipment.origin = {
        nodeId: facts.originNodeId,
        nodeName: node?.name ?? null,
        address: node?.address ?? null,
        city: node?.city ?? null,
        state: node?.state ?? null,
      };
    }
    const measured = facts.measured;
    if (measured) {
      shipment.measured = {
        weightKg: measured.weightKg ?? shipment.parcel.weightKg,
        size: measured.size ?? shipment.parcel.size,
      };
    }
    shipment.status = S.RECEIVED;
    shipment.statusChangedAt = change.occurredAt;
    shipment.feeState = 'charged';
    shipment.chargedKobo = shipment.quotedKobo;
    await this.wallet.captureHold(
      manager,
      shipment.id,
      shipment.quotedKobo,
      `Shipment ${shipment.trackingCode}`,
    );
    await this.events.apply(manager, shipment, S.RECEIVED, {
      nodeName: shipment.origin.nodeName,
      data: reHomed
        ? {
            previousOrigin: {
              nodeId: previousOrigin.nodeId,
              nodeName: previousOrigin.nodeName,
            },
          }
        : null,
    });
    if (!reHomed && !measured) {
      return;
    }

    const parcel = { ...shipment.parcel };
    if (measured?.weightKg !== undefined) {
      parcel.weightKg = measured.weightKg;
    }
    if (
      measured?.lengthCm !== undefined &&
      measured.widthCm !== undefined &&
      measured.heightCm !== undefined
    ) {
      parcel.lengthCm = measured.lengthCm;
      parcel.widthCm = measured.widthCm;
      parcel.heightCm = measured.heightCm;
    }
    if (measured?.size) {
      parcel.size = measured.size;
    }
    let repriced: Awaited<ReturnType<MerchantShipmentService['price']>>;
    try {
      repriced = await this.shipments.price(
        facts.originNodeId,
        shipment.destination.nodeId!,
        parcel,
        { anyNode: true },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Shipment ${shipment.id}: re-pricing at drop-off failed, quote stands: ${reason}`,
      );
      await this.orders.recordRepriceFailure(change.orderId, reason, manager);
      return;
    }
    const previousKobo = shipment.quotedKobo;
    if (
      repriced.amountKobo === previousKobo &&
      repriced.vehicleClass === shipment.vehicleClass
    ) {
      return;
    }
    // The order carries the final price before the courier is booked
    // (cost cap) and for the revenue split at collection.
    await this.orders.repriceAtIntake(
      change.orderId,
      {
        amountKobo: repriced.amountKobo,
        destinationFeeKobo: repriced.destinationFeeKobo,
        vehicleClass: repriced.vehicleClass,
      },
      manager,
    );
    shipment.vehicleClass = repriced.vehicleClass;
    if (repriced.amountKobo === previousKobo) {
      await manager.save(shipment);
      return;
    }
    const differenceKobo = repriced.amountKobo - previousKobo;
    await this.wallet.adjustShipmentCharge(manager, {
      merchantId: shipment.merchantId,
      mode: shipment.mode,
      shipmentId: shipment.id,
      differenceKobo,
      description: `Shipment ${shipment.trackingCode}: re-priced at drop-off`,
    });
    shipment.chargedKobo = repriced.amountKobo;
    shipment.feeBreakdown = repriced.breakdown;
    await this.events.apply(manager, shipment, 'fee_adjusted', {
      nodeName: shipment.origin.nodeName,
      data: {
        adjustment: {
          previousKobo,
          newKobo: repriced.amountKobo,
          differenceKobo,
          reason:
            reHomed && measured
              ? 'measured_and_dropped_elsewhere'
              : reHomed
                ? 'dropped_elsewhere'
                : 'measured',
        },
      },
    });
  }

  // notifyReceiver merchant/both (plan D19): every collection code we
  // issue reaches the merchant, never stored, only in the webhook. The
  // first moves the shipment to ready_for_collection; a replacement
  // (resend, new receiver contact) comes as shipment.updated.
  private async relayCode(
    code: RelayedCode,
    manager: EntityManager,
  ): Promise<void> {
    const shipment = await manager
      .getRepository(MerchantShipmentEntity)
      .createQueryBuilder('s')
      .where('s."trackingCode" = :trackingCode AND s.mode = :mode', {
        trackingCode: code.trackingCode,
        mode: 'live',
      })
      .setLock('pessimistic_write')
      .getOne();
    if (!shipment) {
      return;
    }
    const secrets = { collectionCode: code.collectionCode };
    if (code.kind === 'ready') {
      if (!canTransition(shipment.status, S.READY_FOR_COLLECTION)) {
        return;
      }
      shipment.status = S.READY_FOR_COLLECTION;
      shipment.statusChangedAt = new Date();
      shipment.collectionDeadline = code.collectBy;
      await this.events.apply(manager, shipment, S.READY_FOR_COLLECTION, {
        nodeName: shipment.destination.nodeName,
        secrets,
      });
      return;
    }
    if (shipment.status !== S.READY_FOR_COLLECTION) {
      return;
    }
    await this.events.apply(manager, shipment, 'updated', {
      data: { changed: ['collectionCode'] },
      secrets,
    });
  }
}
