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
import { shipmentView } from './shipment-view';
import { WalletService } from './wallet.service';

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
  ) {}

  async create(
    caller: MerchantCaller,
    dto: CreateShipmentDto,
  ): Promise<ShipmentView> {
    const merchant = await this.writableMerchant(caller);
    return shipmentView(await this.createOne(caller, merchant, dto));
  }

  // Up to 100 in one call; each item validated and created on its own.
  async bulkCreate(
    caller: MerchantCaller,
    items: Record<string, unknown>[],
  ): Promise<BulkResultView[]> {
    const merchant = await this.writableMerchant(caller);
    const results: BulkResultView[] = [];
    for (const [index, item] of items.entries()) {
      const dto = plainToInstance(CreateShipmentDto, item);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      if (errors.length > 0) {
        results.push({
          index,
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Validation failed',
            details: toValidationDetails(errors, `items[${index}]`),
          },
        });
        continue;
      }
      try {
        const shipment = await this.createOne(caller, merchant, dto);
        results.push({ index, ok: true, shipment: shipmentView(shipment) });
      } catch (error) {
        if (!(error instanceof AppException)) {
          throw error;
        }
        results.push({
          index,
          ok: false,
          error: {
            code: error.errorCode,
            message: error.message,
            ...(error.details !== undefined && { details: error.details }),
          },
        });
      }
    }
    return results;
  }

  async get(caller: MerchantCaller, id: string): Promise<ShipmentView> {
    return shipmentView(
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
      shipmentView,
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
        ? await this.availableDestination(dto.destinationNodeId)
        : null;
      repriced = await this.price(
        current.origin.nodeId!,
        destination?.id ?? current.destination.nodeId!,
        dto.parcel ? parcelFrom(dto.parcel) : current.parcel,
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const shipment = await this.shipmentOf(manager, caller, id, true);
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
    return shipmentView(saved);
  }

  async cancel(caller: MerchantCaller, id: string): Promise<ShipmentView> {
    await this.writableMerchant(caller);
    const saved = await this.dataSource.transaction(async (manager) => {
      const shipment = await this.shipmentOf(manager, caller, id, true);
      if (shipment.status !== ShipmentStatus.CREATED) {
        throw new ShipmentNotCancellableException(shipment.status);
      }
      shipment.status = ShipmentStatus.CANCELLED;
      shipment.statusChangedAt = new Date();
      shipment.feeState = 'released';
      await this.wallet.releaseHold(manager, shipment.id);
      return this.events.apply(manager, shipment, 'cancelled');
    });
    return shipmentView(saved);
  }

  async returnToSender(
    caller: MerchantCaller,
    id: string,
  ): Promise<ShipmentView> {
    await this.writableMerchant(caller);
    const saved = await this.dataSource.transaction(async (manager) => {
      const shipment = await this.shipmentOf(manager, caller, id, true);
      const returnable: ShipmentStatus[] = [
        ShipmentStatus.RECEIVED,
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.READY_FOR_COLLECTION,
      ];
      if (!returnable.includes(shipment.status)) {
        throw new ShipmentNotReturnableException(shipment.status);
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
    return shipmentView(saved);
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

  async availableDestination(nodeId: string): Promise<AvailableNode> {
    try {
      return await this.nodes.getAvailable(nodeId);
    } catch (error) {
      if (error instanceof EntityNotFoundException) {
        throw new DestinationNodeUnavailableException();
      }
      throw error;
    }
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

    // Hubs (the default origin) arrive with M5.
    const originType = dto.origin?.type ?? 'hub';
    if (originType === 'hub' || !dto.origin?.nodeId) {
      throw new OriginRequiredException();
    }
    const origin = await this.nodes
      .getAvailable(dto.origin.nodeId)
      .catch((error: unknown) => {
        throw error instanceof EntityNotFoundException
          ? new OriginNodeUnavailableException()
          : error;
      });
    const destination = await this.availableDestination(dto.destinationNodeId);
    const parcel = parcelFrom(dto.parcel);
    const priced = await this.price(origin.id, destination.id, parcel);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const now = new Date();
          const shipment = manager.create(MerchantShipmentEntity, {
            merchantId: caller.merchantId,
            mode: caller.mode,
            reference: dto.reference,
            trackingCode: generateTestTrackingCode(),
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

  private async price(
    originNodeId: string,
    destinationNodeId: string,
    parcel: ShipmentParcel,
  ): Promise<{
    amountKobo: number;
    breakdown: ShipmentFeeBreakdown;
    vehicleClass: string;
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
    );
    const { amountKobo, breakdown } = merchantQuoteAmounts(quote.feeBreakdown, {
      discountRate: 0,
      vatEnabled: this.config.get('VAT_ENABLED', { infer: true }),
    });
    return {
      amountKobo,
      breakdown,
      vehicleClass: quote.feeBreakdown.vehicleClass,
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

  // Writes need a merchant that can ship in this mode. Live shipments open
  // with M4; until then they're refused (reads just come back empty).
  private async writableMerchant(
    caller: MerchantCaller,
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
    if (caller.mode === 'live') {
      if (
        merchant.status !== MerchantStatus.APPROVED &&
        merchant.status !== MerchantStatus.SUSPENDED
      ) {
        throw new MerchantNotApprovedException();
      }
      throw new LiveShipmentsNotAvailableException();
    }
    return merchant;
  }
}
