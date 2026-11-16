import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  AppException,
  EntityNotFoundException,
} from '../../../common/exceptions';
import {
  CursorPage,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import { toValidationDetails } from '../../../common/pipes/validation-exception-factory';
import { Env } from '../../../config/env.validation';
import {
  AvailableNode,
  NodesService,
} from '../../nodes/application/nodes.service';
import { OutboxService } from '../../notifications/application/outbox.service';
import { DeliveryQuoteService } from '../../payments/application/delivery-quote.service';
import {
  DestinationNodeUnavailableException,
  DuplicateReferenceException,
  LiveShipmentsNotAvailableException,
  MerchantNotApprovedException,
  MerchantNotEditableException,
  MerchantSuspendedException,
  ShipmentCreationPausedException,
  DailyLimitReachedException,
  OriginNodeUnavailableException,
  OriginRequiredException,
  ReceiverRelayNotEnabledException,
  ReceiverUnreachableException,
  ShipmentNotCancellableException,
  ShipmentNotEditableException,
  ShipmentNotReturnableException,
} from '../domain/exceptions/merchant.exceptions';
import { MerchantStatus } from '../domain/merchant.enums';
import { merchantQuoteAmounts } from '../domain/merchant-quote';
import {
  DROP_DEADLINE_DAYS,
  generateTestTrackingCode,
  isFinal,
  ShipmentStatus,
} from '../domain/shipment';
import { MerchantShipmentEventEntity } from '../infrastructure/entities/merchant-shipment-event.entity';
import {
  MerchantShipmentEntity,
  ShipmentFeeBreakdown,
  ShipmentNodeSnapshot,
  ShipmentParcel,
} from '../infrastructure/entities/merchant-shipment.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import {
  BulkResultView,
  CreateShipmentDto,
  ListShipmentsQueryDto,
  ShipmentParcelDto,
  ShipmentView,
  TimelineEntryView,
  UpdateShipmentDto,
} from '../interface/dto/shipment.dto';
import { MerchantCaller } from './merchant-state';
import { ShipmentEventsService } from './shipment-events.service';
import { ShipmentPresenter } from './shipment-presenter';
import { WalletService } from './wallet.service';
import { MerchantPricingService } from './merchant-pricing.service';
import { OrdersService } from '../../orders/application/orders.service';
import { ParcelRecallService } from '../../handoffs/application/parcel-recall.service';
import { lagosDate } from '../../../common/time/working-days';
import { defaultTierFor, resolveLimits } from '../domain/merchant-limits';

const MAX_TRACKING_CODE_ATTEMPTS = 5;

export const nodeSnapshot = (node: AvailableNode): ShipmentNodeSnapshot => ({
  nodeId: node.id,
  nodeName: node.name,
  address: node.address,
  city: node.city,
  state: node.state,
});

const parcelFrom = (dto: ShipmentParcelDto): ShipmentParcel => ({
  description: dto.description,
  size: dto.size,
  weightKg: dto.weightKg ?? null,
  lengthCm: dto.lengthCm ?? null,
  widthCm: dto.widthCm ?? null,
  heightCm: dto.heightCm ?? null,
  handling: dto.handling ?? [],
  declaredValueKobo: dto.declaredValueKobo ?? null,
});

function constraintOf(error: unknown): string | undefined {
  return error instanceof QueryFailedError
    ? (error.driverError as { constraint?: string } | undefined)?.constraint
    : undefined;
}

// Shipments API (MERCHANT_API.md §7). M2: test mode, simulated entirely in
// this module; live shipments (orders, wallet) arrive with M4.
@Injectable()
export class MerchantShipmentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodes: NodesService,
    private readonly quotes: DeliveryQuoteService,
    private readonly outbox: OutboxService,
    private readonly events: ShipmentEventsService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService<Env, true>,
    private readonly presenter: ShipmentPresenter,
    private readonly orders: OrdersService,
    private readonly parcelRecall: ParcelRecallService,
    private readonly pricing: MerchantPricingService,
  ) {}

  async create(
    caller: MerchantCaller,
    dto: CreateShipmentDto,
  ): Promise<ShipmentView> {
    const merchant = await this.writableMerchant(caller, true);
    return this.presenter.view(await this.createOne(caller, merchant, dto));
  }

  // Up to 100 in one call; each item validated and created on its own.
  async bulkCreate(
    caller: MerchantCaller,
    items: Record<string, unknown>[],
  ): Promise<BulkResultView[]> {
    const merchant = await this.writableMerchant(caller, true);
    const results: BulkResultView[] = [];
    for (const [index, item] of items.entries()) {
      results.push({
        index,
        ...(await this.createItem(caller, merchant, item, `items[${index}]`)),
      });
    }
    return results;
  }

  // The merchant, if it may create shipments in this mode now (throws the
  // reason otherwise). Bulk and imports check once, then per chunk.
  creatableMerchant(caller: MerchantCaller): Promise<MerchantEntity> {
    return this.writableMerchant(caller, true);
  }

  // One untrusted item (bulk, import row): validated like POST /shipments,
  // then created. Business errors come back as a result, not thrown;
  // `path` prefixes validation field names (items[3], row 4, …).
  async createItem(
    caller: MerchantCaller,
    merchant: MerchantEntity,
    item: Record<string, unknown>,
    path: string,
  ): Promise<
    | { ok: true; shipment: ShipmentView }
    | {
        ok: false;
        error: { code: string; message: string; details?: unknown };
      }
  > {
    const dto = plainToInstance(CreateShipmentDto, item);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          details: toValidationDetails(errors, path),
        },
      };
    }
    try {
      const shipment = await this.createOne(caller, merchant, dto);
      return { ok: true, shipment: this.presenter.view(shipment) };
    } catch (error) {
      if (!(error instanceof AppException)) {
        throw error;
      }
      return {
        ok: false,
        error: {
          code: error.errorCode,
          message: error.message,
          ...(error.details !== undefined && { details: error.details }),
        },
      };
    }
  }

  async get(caller: MerchantCaller, id: string): Promise<ShipmentView> {
    return this.presenter.view(
      await this.shipmentOf(this.dataSource.manager, caller, id),
    );
  }

  async list(
    caller: MerchantCaller,
    query: ListShipmentsQueryDto,
  ): Promise<CursorPage<ShipmentView>> {
    const after = decodeCursor(query.cursor);
    const syncing = query.updatedSince !== undefined;
    const qb = this.dataSource
      .getRepository(MerchantShipmentEntity)
      .createQueryBuilder('s')
      .where('s."merchantId" = :merchantId AND s.mode = :mode', {
        merchantId: caller.merchantId,
        mode: caller.mode,
      });
    if (query.reference) {
      qb.andWhere('s.reference = :reference', { reference: query.reference });
    }
    if (query.status) {
      qb.andWhere('s.status = :status', { status: query.status });
    }
    if (query.destinationNodeId) {
      qb.andWhere(`s.destination->>'nodeId' = :destination`, {
        destination: query.destinationNodeId,
      });
    }
    if (query.manifestId) {
      qb.andWhere('s."manifestId" = :manifestId', {
        manifestId: query.manifestId,
      });
    }
    if (query.createdFrom) {
      qb.andWhere('s."createdAt" >= :createdFrom', {
        createdFrom: query.createdFrom,
      });
    }
    if (query.createdTo) {
      qb.andWhere('s."createdAt" < :createdTo', { createdTo: query.createdTo });
    }
    if (syncing) {
      qb.andWhere('s."updatedAt" >= :updatedSince', {
        updatedSince: query.updatedSince,
      });
      const updated = cursorTime('s."updatedAt"');
      if (after) {
        qb.andWhere(`(${updated}, s.id) > (:t::timestamptz, :id::uuid)`, after);
      }
      qb.orderBy(updated, 'ASC').addOrderBy('s.id', 'ASC');
    } else {
      const created = cursorTime('s."createdAt"');
      if (after) {
        qb.andWhere(`(${created}, s.id) < (:t::timestamptz, :id::uuid)`, after);
      }
      qb.orderBy(created, 'DESC').addOrderBy('s.id', 'DESC');
    }
    const rows = await qb.take(query.limit + 1).getMany();
    return toCursorPage(
      rows,
      query.limit,
      (s) => ({
        t: (syncing ? s.updatedAt : s.createdAt).toISOString(),
        id: s.id,
      }),
      (s) => this.presenter.view(s),
    );
  }

  async timeline(
    caller: MerchantCaller,
    id: string,
  ): Promise<TimelineEntryView[]> {
    const shipment = await this.shipmentOf(this.dataSource.manager, caller, id);
    const events = await this.dataSource.manager.find(
      MerchantShipmentEventEntity,
      { where: { shipmentId: shipment.id }, order: { sequence: 'ASC' } },
    );
    return events.map((e) => ({
      type: e.type,
      at: e.createdAt.toISOString(),
      nodeName: e.nodeName,
      sequence: e.sequence,
      data: e.data,
    }));
  }

  async update(
    caller: MerchantCaller,
    id: string,
    dto: UpdateShipmentDto,
  ): Promise<ShipmentView> {
    const merchant = await this.writableMerchant(caller);
    // Outside the transaction: Node lookups and pricing.
    const current = await this.shipmentOf(this.dataSource.manager, caller, id);
    const routeChange = dto.destinationNodeId !== undefined || !!dto.parcel;
    let repriced: Awaited<ReturnType<typeof this.price>> | null = null;
    let destination: AvailableNode | null = null;
    if (routeChange) {
      if (current.status !== ShipmentStatus.CREATED) {
        throw new ShipmentNotEditableException(
          dto.parcel ? 'parcel' : 'destinationNodeId',
          current.status,
        );
      }
      destination = dto.destinationNodeId
        ? await this.availableDestination(dto.destinationNodeId, {
            live: current.mode === 'live',
          })
        : null;
      repriced = await this.price(
        current.origin.nodeId!,
        destination?.id ?? current.destination.nodeId!,
        dto.parcel ? parcelFrom(dto.parcel) : current.parcel,
        { merchantId: caller.merchantId, mode: caller.mode },
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const { shipment } = await this.lockForWrite(manager, caller, id);
      const changed: string[] = [];
      if (dto.receiver) {
        if (
          isFinal(shipment.status) ||
          shipment.status === ShipmentStatus.COLLECTED
        ) {
          throw new ShipmentNotEditableException('receiver', shipment.status);
        }
        if (dto.receiver.name !== undefined) {
          shipment.receiverName = dto.receiver.name;
        }
        if (dto.receiver.phone !== undefined) {
          shipment.receiverPhone = dto.receiver.phone;
        }
        if (dto.receiver.email !== undefined) {
          shipment.receiverEmail = dto.receiver.email;
        }
        this.assertReachable(
          merchant,
          shipment.notifyReceiver,
          shipment.receiverEmail,
        );
        if (shipment.orderId) {
          await this.orders
            .updateReceiver(
              shipment.orderId,
              {
                receiverFullName: dto.receiver.name,
                receiverPhone: dto.receiver.phone,
                receiverEmail: dto.receiver.email,
              },
              manager,
            )
            .catch((error: unknown) => {
              // Collected or ended since (orders' ILLEGAL_ORDER_TRANSITION).
              throw error instanceof AppException &&
                error.errorCode === 'ILLEGAL_ORDER_TRANSITION'
                ? new ShipmentNotEditableException('receiver', shipment.status)
                : error;
            });
          // Already on the shelf: the new contact gets a fresh code.
          await this.parcelRecall.reissueReceiverCode(
            shipment.orderId,
            manager,
          );
        }
        changed.push('receiver');
      }
      if (repriced) {
        // Raced with a drop-off scan: the scan wins.
        if (shipment.status !== ShipmentStatus.CREATED) {
          throw new ShipmentNotEditableException('parcel', shipment.status);
        }
        await this.wallet.changeHold(manager, shipment.id, repriced.amountKobo);
        if (destination) {
          shipment.destination = nodeSnapshot(destination);
          changed.push('destination');
        }
        if (dto.parcel) {
          shipment.parcel = parcelFrom(dto.parcel);
          changed.push('parcel');
        }
        shipment.quotedKobo = repriced.amountKobo;
        shipment.feeBreakdown = repriced.breakdown;
        shipment.vehicleClass = repriced.vehicleClass;
        if (shipment.orderId) {
          await this.orders.updateBeforeDropOff(
            shipment.orderId,
            {
              destinationNodeId: shipment.destination.nodeId!,
              parcelDescription: shipment.parcel.description,
              parcelSize: shipment.parcel.size as ShipmentParcelDto['size'],
              weightKg: shipment.parcel.weightKg,
              lengthCm: shipment.parcel.lengthCm,
              widthCm: shipment.parcel.widthCm,
              heightCm: shipment.parcel.heightCm,
              handling: shipment.parcel.handling,
              vehicleClass: repriced.vehicleClass,
              amountKobo: repriced.amountKobo,
              destinationFeeKobo: repriced.destinationFeeKobo,
              discountKobo: repriced.discountKobo,
            },
            manager,
          );
        }
      }
      if (dto.metadata !== undefined) {
        shipment.metadata = dto.metadata;
        changed.push('metadata');
      }
      if (changed.length === 0) {
        return shipment;
      }
      return this.events.apply(manager, shipment, 'updated', {
        data: { changed },
      });
    });
    return this.presenter.view(saved);
  }

  async cancel(caller: MerchantCaller, id: string): Promise<ShipmentView> {
    await this.writableMerchant(caller);
    const saved = await this.dataSource.transaction(async (manager) => {
      const { shipment } = await this.lockForWrite(manager, caller, id);
      if (shipment.status !== ShipmentStatus.CREATED) {
        throw new ShipmentNotCancellableException(shipment.status);
      }
      shipment.status = ShipmentStatus.CANCELLED;
      shipment.statusChangedAt = new Date();
      shipment.feeState = 'released';
      await this.wallet.releaseHold(manager, shipment.id);
      const cancelled = await this.events.apply(manager, shipment, 'cancelled');
      // The order follows; the mirror sees the shipment already cancelled.
      if (shipment.orderId) {
        await this.orders.markCancelled(shipment.orderId, manager, {
          reason: 'merchant_cancelled',
        });
      }
      return cancelled;
    });
    return this.presenter.view(saved);
  }

  async returnToSender(
    caller: MerchantCaller,
    id: string,
  ): Promise<ShipmentView> {
    await this.writableMerchant(caller);
    const saved = await this.dataSource.transaction(async (manager) => {
      const { shipment, orderStatus } = await this.lockForWrite(
        manager,
        caller,
        id,
      );
      const returnable: ShipmentStatus[] = [
        ShipmentStatus.RECEIVED,
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.READY_FOR_COLLECTION,
      ];
      if (!returnable.includes(shipment.status)) {
        throw new ShipmentNotReturnableException(shipment.status);
      }
      if (shipment.orderId) {
        if (orderStatus === 'ready_for_collection') {
          // On the buyer's shelf: back now (code voided, return courier
          // booked); the mirror moves the shipment to returning.
          await this.parcelRecall.returnFromShelf(
            shipment.orderId,
            'merchant_request',
            manager,
          );
          return this.shipmentOf(manager, caller, id);
        }
        // Still on its way: it turns round when it reaches the buyer's
        // Node, without being offered to them.
        if (!(await this.orders.requestReturn(shipment.orderId, manager))) {
          throw new ShipmentNotReturnableException(shipment.status);
        }
      }
      shipment.status = ShipmentStatus.RETURNING;
      shipment.statusChangedAt = new Date();
      shipment.returnInfo = {
        reason: 'merchant_request',
        readyForCollectionAt: null,
      };
      return this.events.apply(manager, shipment, 'returning', {
        data: { reason: 'merchant_request' },
      });
    });
    return this.presenter.view(saved);
  }

  // For writes. A live shipment's order row is locked before the shipment,
  // the same order every order-status change takes (the order update, then
  // the mirror locking the shipment), so a merchant action racing a Node
  // scan queues instead of deadlocking.
  private async lockForWrite(
    manager: EntityManager,
    caller: MerchantCaller,
    id: string,
  ): Promise<{ shipment: MerchantShipmentEntity; orderStatus: string | null }> {
    const peek = await this.shipmentOf(manager, caller, id);
    let orderStatus: string | null = null;
    if (peek.orderId) {
      const [order] = await manager.query<{ status: string }[]>(
        `SELECT status FROM orders WHERE id = $1 FOR UPDATE`,
        [peek.orderId],
      );
      orderStatus = order?.status ?? null;
    }
    return {
      shipment: await this.shipmentOf(manager, caller, id, true),
      orderStatus,
    };
  }

  // Row-locked when `lock`. Another merchant's or the other mode's id is
  // a plain 404.
  async shipmentOf(
    manager: EntityManager,
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
    lock = false,
  ): Promise<MerchantShipmentEntity> {
    const qb = manager
      .getRepository(MerchantShipmentEntity)
      .createQueryBuilder('s')
      .where('s.id = :id AND s."merchantId" = :merchantId AND s.mode = :mode', {
        id,
        merchantId: caller.merchantId,
        mode: caller.mode,
      });
    if (lock) {
      qb.setLock('pessimistic_write');
    }
    const shipment = await qb.getOne();
    if (!shipment) {
      throw new EntityNotFoundException('Shipment', id);
    }
    return shipment;
  }

  // `live`: also the Node's daily cap on merchant parcels (M5c), counted
  // over today's live shipments addressed to it (Lagos day).
  async availableDestination(
    nodeId: string,
    options: { live?: boolean } = {},
  ): Promise<AvailableNode> {
    let node: AvailableNode;
    try {
      node = await this.nodes.getAvailable(nodeId);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        throw new DestinationNodeUnavailableException();
      }
      throw error;
    }
    if (options.live) {
      const [row] = await this.dataSource.query<
        { cap: number | null; today: number }[]
      >(
        `SELECT n."merchantDailyArrivalCap" AS cap,
                (SELECT count(*)::int FROM merchant_shipments s
                  WHERE s.mode = 'live' AND s.destination->>'nodeId' = $1
                    AND s."createdAt" >= $2) AS today
           FROM nodes n WHERE n.id = $1::uuid`,
        [nodeId, lagosDayStart(new Date())],
      );
      if (row?.cap !== null && row?.cap !== undefined && row.today >= row.cap) {
        throw new DestinationNodeUnavailableException();
      }
    }
    return node;
  }

  private async createOne(
    caller: MerchantCaller,
    merchant: MerchantEntity,
    dto: CreateShipmentDto,
  ): Promise<MerchantShipmentEntity> {
    const existing = await this.byReference(caller, dto.reference);
    if (existing) {
      throw new DuplicateReferenceException(existing);
    }
    const notifyReceiver = dto.notifyReceiver ?? 'locoomo';
    this.assertReachable(merchant, notifyReceiver, dto.receiver.email ?? null);
    const live = caller.mode === 'live';
    if (live) {
      await this.assertDailyLimit(merchant);
    }

    // `hub` (the default) is the merchant's assigned hub (plan D2).
    const originType = dto.origin?.type ?? 'hub';
    const originNodeId =
      originType === 'hub' ? merchant.hubNodeId : dto.origin?.nodeId;
    if (!originNodeId) {
      throw new OriginRequiredException();
    }
    const origin = await this.nodes
      .getAvailable(originNodeId)
      .catch((error: unknown) => {
        throw error instanceof EntityNotFoundException
          ? new OriginNodeUnavailableException()
          : error;
      });
    const destination = await this.availableDestination(dto.destinationNodeId, {
      live,
    });
    const parcel = parcelFrom(dto.parcel);
    const priced = await this.price(origin.id, destination.id, parcel, {
      merchantId: caller.merchantId,
      mode: caller.mode,
    });

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const now = new Date();
          // Live: a real order behind it (plan §6.1), created first so the
          // shipment carries its LCM- tracking code. It holds no origin
          // slot until the parcel is dropped off.
          const order = live
            ? await this.orders.createForMerchant(
                {
                  merchantId: caller.merchantId,
                  notifyReceiver,
                  originNodeId: origin.id,
                  destinationNodeId: destination.id,
                  receiverFullName: dto.receiver.name,
                  receiverEmail: dto.receiver.email ?? null,
                  receiverPhone: dto.receiver.phone,
                  parcelDescription: parcel.description,
                  parcelSize: parcel.size as ShipmentParcelDto['size'],
                  weightKg: parcel.weightKg,
                  lengthCm: parcel.lengthCm,
                  widthCm: parcel.widthCm,
                  heightCm: parcel.heightCm,
                  handling: parcel.handling,
                  vehicleClass: priced.vehicleClass,
                  amountKobo: priced.amountKobo,
                  destinationFeeKobo: priced.destinationFeeKobo,
                  discountKobo: priced.discountKobo,
                },
                manager,
              )
            : null;
          const shipment = manager.create(MerchantShipmentEntity, {
            merchantId: caller.merchantId,
            mode: caller.mode,
            reference: dto.reference,
            orderId: order?.id ?? null,
            trackingCode: order?.trackingCode ?? generateTestTrackingCode(),
            status: ShipmentStatus.CREATED,
            sequence: 1,
            statusChangedAt: now,
            originType,
            origin: nodeSnapshot(origin),
            destination: nodeSnapshot(destination),
            destinationChanged: false,
            receiverName: dto.receiver.name,
            receiverPhone: dto.receiver.phone,
            receiverEmail: dto.receiver.email ?? null,
            parcel,
            measured: null,
            externalBarcode: dto.externalBarcode ?? null,
            manifestId: null,
            quotedKobo: priced.amountKobo,
            chargedKobo: null,
            feeState: 'held',
            feeBreakdown: priced.breakdown,
            vehicleClass: priced.vehicleClass,
            dropDeadline: new Date(
              now.getTime() + DROP_DEADLINE_DAYS[originType] * 86_400_000,
            ),
            notifyReceiver,
            metadata: dto.metadata ?? {},
            createdByKeyId: caller.keyId,
            createdByUserId: caller.userId,
          });
          const saved = await this.events.apply(manager, shipment, 'created', {
            bump: false,
            nodeName: null,
          });
          // 402 here rolls the whole create back.
          await this.wallet.placeHold(manager, {
            merchantId: caller.merchantId,
            mode: caller.mode,
            shipmentId: saved.id,
            amountKobo: priced.amountKobo,
          });
          return saved;
        });
      } catch (error) {
        const constraint = constraintOf(error);
        if (constraint === 'UQ_merchant_shipments_reference') {
          const raced = await this.byReference(caller, dto.reference);
          if (raced) {
            throw new DuplicateReferenceException(raced);
          }
        }
        if (
          constraint === 'UQ_merchant_shipments_tracking' &&
          attempt < MAX_TRACKING_CODE_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  // The merchant price for a route and parcel. `anyNode`: also price from
  // a Node that isn't publicly listed (a parcel re-homed at drop-off).
  async price(
    originNodeId: string,
    destinationNodeId: string,
    parcel: ShipmentParcel,
    options: {
      anyNode?: boolean;
      merchantId: string;
      mode: MerchantCaller['mode'];
    },
  ): Promise<{
    amountKobo: number;
    breakdown: ShipmentFeeBreakdown;
    vehicleClass: string;
    // The destination Node's share, carried on the order (revenue split).
    destinationFeeKobo: number;
    // The volume discount taken off (positive), carried on the order (E7).
    discountKobo: number;
  }> {
    const quote = await this.quotes.quote(
      { originNodeId, destinationNodeId },
      {
        parcelSize: parcel.size as ShipmentParcelDto['size'],
        weightKg: parcel.weightKg,
        lengthCm: parcel.lengthCm,
        widthCm: parcel.widthCm,
        heightCm: parcel.heightCm,
        handling: parcel.handling,
      },
      { restrictToPublicNodes: !options.anyNode },
    );
    const discount = await this.pricing.discountFor(
      options.merchantId,
      options.mode,
    );
    const { amountKobo, breakdown } = merchantQuoteAmounts(quote.feeBreakdown, {
      discountRate: discount.percent / 100,
      vatEnabled: this.config.get('VAT_ENABLED', { infer: true }),
      maxDiscountKobo: await this.pricing.discountCap(
        quote.feeBreakdown.totalKobo,
        quote.feeBreakdown.destinationFeeKobo,
      ),
    });
    return {
      amountKobo,
      breakdown,
      vehicleClass: quote.feeBreakdown.vehicleClass,
      destinationFeeKobo: quote.feeBreakdown.destinationFeeKobo,
      discountKobo: -breakdown.volumeDiscountKobo,
    };
  }

  private assertReachable(
    merchant: MerchantEntity,
    notifyReceiver: string,
    email: string | null,
  ): void {
    if (notifyReceiver !== 'locoomo' && !merchant.receiverCodeRelay) {
      throw new ReceiverRelayNotEnabledException();
    }
    if (notifyReceiver === 'locoomo' && !email && !this.outbox.isSmsEnabled()) {
      throw new ReceiverUnreachableException();
    }
  }

  private async byReference(
    caller: MerchantCaller,
    reference: string,
  ): Promise<string | null> {
    const row = await this.dataSource.manager.findOne(MerchantShipmentEntity, {
      where: {
        merchantId: caller.merchantId,
        mode: caller.mode,
        reference,
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  // Writes need a merchant that can ship in this mode. Changing, cancelling
  // or recalling existing live shipments works while suspended (in-flight
  // parcels continue, plan §6.3); creating new ones doesn't.
  private async writableMerchant(
    caller: MerchantCaller,
    creating = false,
  ): Promise<MerchantEntity> {
    const merchant = await this.dataSource.manager.findOneByOrFail(
      MerchantEntity,
      { id: caller.merchantId },
    );
    if (
      merchant.status === MerchantStatus.CLOSED ||
      merchant.status === MerchantStatus.REJECTED
    ) {
      throw new MerchantNotEditableException(merchant.status);
    }
    if (caller.mode !== 'live') {
      return merchant;
    }
    if (
      merchant.status !== MerchantStatus.APPROVED &&
      merchant.status !== MerchantStatus.SUSPENDED
    ) {
      throw new MerchantNotApprovedException();
    }
    if (!creating) {
      return merchant;
    }
    if (!this.config.get('MERCHANT_LIVE_SHIPMENTS_ENABLED', { infer: true })) {
      throw new LiveShipmentsNotAvailableException();
    }
    if (merchant.status === MerchantStatus.SUSPENDED) {
      throw new MerchantSuspendedException();
    }
    if (merchant.creationPaused) {
      throw new ShipmentCreationPausedException();
    }
    return merchant;
  }

  // Live shipments per Lagos day (plan §4.2, D12). Generous by default; an
  // approximate count is fine (it's a safety net, not a quota to the unit).
  private async assertDailyLimit(merchant: MerchantEntity): Promise<void> {
    const { liveShipmentsPerDay } = resolveLimits(
      merchant.tier ?? defaultTierFor(merchant.type),
      merchant.limitOverrides,
    );
    if (liveShipmentsPerDay === null) {
      return;
    }
    const [{ count }] = await this.dataSource.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM merchant_shipments
        WHERE "merchantId" = $1 AND mode = 'live'
          AND "createdAt" >= ($2::date::timestamp AT TIME ZONE 'Africa/Lagos')`,
      [merchant.id, lagosDate(new Date())],
    );
    if (count >= liveShipmentsPerDay) {
      throw new DailyLimitReachedException(liveShipmentsPerDay);
    }
  }
}

// Midnight in Lagos (UTC+1) of the day `instant` falls in.
function lagosDayStart(instant: Date): Date {
  const lagos = new Date(instant.getTime() + 3_600_000)
    .toISOString()
    .slice(0, 10);
  return new Date(`${lagos}T00:00:00+01:00`);
}
