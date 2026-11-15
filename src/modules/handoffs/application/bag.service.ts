import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { EntityNotFoundException } from '../../../common/exceptions';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import type { Env } from '../../../config/env.validation';
import { AdminPermissionService } from '../../identity/application/admin-permission.service';
import {
  CourierHandoverInfo,
  CourierHandoverService,
} from '../../logistics/application/courier-handover.service';
import { DeliveryDispatchService } from '../../logistics/application/delivery-dispatch.service';
import { DeliveryEventBus } from '../../logistics/application/delivery-event-bus';
import type {
  DeliveryEventListener,
  DeliveryEventNotice,
} from '../../logistics/application/delivery-event-types';
import { DeliveryEventType } from '../../logistics/application/delivery-vocabulary';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import { renderEmail } from '../../notifications/application/email-template';
import { OutboxService } from '../../notifications/application/outbox.service';
import {
  OrderStatusChanged,
  OrderStatusEventBus,
  OrderStatusListener,
} from '../../orders/application/order-status-event-bus';
import {
  BAG_MAX_PARCELS,
  BagStatus,
  MISSING_FROM_BAG_AFTER_HOURS,
  newBagCode,
  normaliseBagCode,
} from '../domain/bag';
import { BagNotSealableException } from '../domain/exceptions/bag.exceptions';
import { BagEntity } from '../infrastructure/entities/bag.entity';

const INTERVAL_NAME = 'bags';
const INTERVAL_MS = 15 * 60_000;

export interface BagNodeRef {
  id: string;
  name: string;
  city: string;
}

export interface BagView {
  code: string;
  status: BagStatus;
  origin: BagNodeRef;
  destination: BagNodeRef;
  parcelCount: number;
  sealedAt: string | null;
  arrivedAt: string | null;
  unpackedAt: string | null;
  createdAt: string;
}

export interface BagDetailView extends BagView {
  parcels: {
    trackingCode: string;
    status: string;
    shelfNumber: number | null;
  }[];
}

export interface PlacedInBag {
  code: string;
  parcelCount: number;
  // Full: it sealed itself with this parcel.
  sealed: boolean;
}

export interface BagSweepRun {
  redispatched: number;
  missingAlerts: number;
}

// Bags (plan §7.2, D17, M5b). A merchant parcel dropped off at a hub goes
// into the open bag for its destination instead of getting its own
// courier. Sealing a bag (by staff, or automatically at BAG_MAX_PARCELS)
// books ONE courier leg for it; logistics publishes that leg's events once
// per parcel, so every parcel moves with the bag. The bag follows: in
// transit, arrived, and unpacked once each parcel is scanned in at the
// destination (the normal intake). Parcels still not scanned a day after
// arrival are flagged to ops.
@Injectable()
export class BagService
  implements
    DeliveryEventListener,
    OrderStatusListener,
    OnModuleInit,
    OnApplicationShutdown
{
  private readonly logger = new Logger(BagService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly dispatch: DeliveryDispatchService,
    private readonly deliveryBus: DeliveryEventBus,
    private readonly orderBus: OrderStatusEventBus,
    private readonly nodeOperators: NodeOperatorQueryService,
    private readonly handover: CourierHandoverService,
    private readonly adminPermissions: AdminPermissionService,
    private readonly outbox: OutboxService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.deliveryBus.subscribe(this);
    this.orderBus.subscribe(this);
    if (shouldRunBackgroundJobs(this.config)) {
      this.scheduler.addInterval(
        INTERVAL_NAME,
        setInterval(() => void this.tick(), INTERVAL_MS),
      );
    }
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  // ─── Drop-off at a hub ────────────────────────────────────────────────

  async isHub(nodeId: string, manager: EntityManager): Promise<boolean> {
    const [row] = await manager.query<{ isHub: boolean }[]>(
      `SELECT "isHub" FROM nodes WHERE id = $1`,
      [nodeId],
    );
    return row?.isHub === true;
  }

  // Inside the drop-off transaction (the order is locked): into the open
  // bag for its destination, opened now if there's none.
  async place(
    order: { id: string; originNodeId: string; destinationNodeId: string },
    manager: EntityManager,
  ): Promise<PlacedInBag> {
    let bag: BagEntity | null = null;
    // Twice at most: another drop-off may fill (and seal) the bag between
    // our insert and our lock; then a fresh one opens.
    for (let attempt = 0; !bag && attempt < 2; attempt++) {
      await manager.query(
        `INSERT INTO bags (code, "originNodeId", "destinationNodeId", status)
         VALUES ($1, $2, $3, 'open')
         ON CONFLICT ("originNodeId", "destinationNodeId") WHERE status = 'open'
         DO NOTHING`,
        [newBagCode(), order.originNodeId, order.destinationNodeId],
      );
      bag = await manager
        .getRepository(BagEntity)
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where(
          `b."originNodeId" = :origin AND b."destinationNodeId" = :destination AND b.status = 'open'`,
          { origin: order.originNodeId, destination: order.destinationNodeId },
        )
        .getOne();
    }
    if (!bag) {
      throw new Error(
        `No open bag ${order.originNodeId} → ${order.destinationNodeId} for order ${order.id}`,
      );
    }
    await manager.query(`UPDATE orders SET "bagId" = $1 WHERE id = $2`, [
      bag.id,
      order.id,
    ]);
    bag.parcelCount += 1;
    await manager.save(bag);
    const full = bag.parcelCount >= BAG_MAX_PARCELS;
    if (full) {
      await this.seal(manager, bag, null);
    }
    return { code: bag.code, parcelCount: bag.parcelCount, sealed: full };
  }

  // ─── Node app ─────────────────────────────────────────────────────────

  // Bags at the caller's Nodes: packing or leaving (origin), or coming in
  // and being unpacked (destination). Newest first, up to 200.
  async listForNode(userId: string, status?: BagStatus): Promise<BagView[]> {
    const nodeIds = await this.nodeOperators.getNodeIdsForUser(userId);
    if (nodeIds.length === 0) {
      return [];
    }
    const params: unknown[] = [nodeIds];
    let filter = `b.status NOT IN ('unpacked', 'cancelled')`;
    if (status) {
      params.push(status);
      filter = `b.status = $2`;
    }
    const bags = await this.dataSource.query<{ id: string }[]>(
      `SELECT b.id FROM bags b
        WHERE (b."originNodeId" = ANY($1) OR b."destinationNodeId" = ANY($1))
          AND ${filter}
        ORDER BY b."createdAt" DESC
        LIMIT 200`,
      params,
    );
    return this.views(bags.map((b) => b.id));
  }

  async detail(userId: string, codeInput: string): Promise<BagDetailView> {
    const bag = await this.findForNode(userId, codeInput);
    const [view] = await this.views([bag.id]);
    const parcels = await this.dataSource.query<
      { trackingCode: string; status: string; shelfNumber: number | null }[]
    >(
      `SELECT "trackingCode", status, "shelfNumber" FROM orders
        WHERE "bagId" = $1 ORDER BY "trackingCode"`,
      [bag.id],
    );
    return { ...view, parcels };
  }

  // Staff close the bag (tag on, ready for the courier) before it's full.
  async sealByStaff(userId: string, codeInput: string): Promise<BagDetailView> {
    const found = await this.findForNode(userId, codeInput, 'origin');
    await this.dataSource.transaction(async (manager) => {
      const bag = await manager
        .getRepository(BagEntity)
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: found.id })
        .getOneOrFail();
      if (bag.status !== BagStatus.OPEN) {
        throw new BagNotSealableException(bag.status);
      }
      await this.seal(manager, bag, userId);
    });
    return this.detail(userId, found.code);
  }

  // The courier's codes for this bag: `pickup` for staff at the hub,
  // `delivery` for staff at the destination. null when there's nothing to
  // hand over yet (or the courier doesn't use provider codes).
  async courierHandover(
    userId: string,
    codeInput: string,
  ): Promise<(CourierHandoverInfo & { kind: 'pickup' | 'delivery' }) | null> {
    const bag = await this.findForNode(userId, codeInput);
    const nodeIds = await this.nodeOperators.getNodeIdsForUser(userId);
    const kind =
      bag.status === BagStatus.SEALED && nodeIds.includes(bag.originNodeId)
        ? 'pickup'
        : bag.status === BagStatus.IN_TRANSIT &&
            nodeIds.includes(bag.destinationNodeId)
          ? 'delivery'
          : null;
    if (!kind) {
      return null;
    }
    const info = await this.handover.handoverForBag(bag.id);
    return info ? { ...info, kind } : null;
  }

  // ─── Listeners ────────────────────────────────────────────────────────

  // The bag follows its leg. Published once per parcel: idempotent.
  async onDeliveryEvent(
    notice: DeliveryEventNotice,
    manager: EntityManager,
  ): Promise<void> {
    if (!notice.bagId) {
      return;
    }
    if (notice.event === DeliveryEventType.PICKED_UP) {
      await manager.query(
        `UPDATE bags SET status = 'in_transit', "updatedAt" = now()
          WHERE id = $1 AND status = 'sealed'`,
        [notice.bagId],
      );
    } else if (notice.event === DeliveryEventType.DELIVERED) {
      await manager.query(
        `UPDATE bags SET status = 'arrived', "arrivedAt" = now(), "updatedAt" = now()
          WHERE id = $1 AND status IN ('sealed', 'in_transit')`,
        [notice.bagId],
      );
    }
  }

  async onOrderStatusChanged(
    change: OrderStatusChanged,
    manager: EntityManager,
  ): Promise<void> {
    if (change.source !== 'merchant') {
      return;
    }
    // Lost or damaged while still being packed: out of the bag.
    if (change.toStatus === 'exception') {
      const [row] = await manager.query<{ bagId: string | null }[]>(
        `UPDATE orders o SET "bagId" = NULL
           FROM bags b
          WHERE o.id = $1 AND b.id = o."bagId" AND b.status = 'open'
          RETURNING b.id AS "bagId"`,
        [change.orderId],
      );
      if (row?.bagId) {
        await manager.query(
          `UPDATE bags SET "parcelCount" = "parcelCount" - 1, "updatedAt" = now()
            WHERE id = $1`,
          [row.bagId],
        );
      }
    }
    // Scanned in at the destination (or turned round, or lost there): the
    // bag is unpacked once none of its parcels is still waiting.
    if (change.fromStatus === 'arrived_at_destination') {
      await manager.query(
        `UPDATE bags b SET status = 'unpacked', "unpackedAt" = now(), "updatedAt" = now()
          FROM orders o
         WHERE o.id = $1 AND b.id = o."bagId" AND b.status = 'arrived'
           AND NOT EXISTS (
             SELECT 1 FROM orders x
              WHERE x."bagId" = b.id AND x.status = 'arrived_at_destination')`,
        [change.orderId],
      );
    }
  }

  // ─── Worker ───────────────────────────────────────────────────────────

  // Sealed bags no bag courier could take are routed again; parcels still
  // unscanned a day after their bag arrived are flagged to ops (once).
  async run(now = new Date()): Promise<BagSweepRun> {
    const waiting = await this.dataSource.query<{ id: string }[]>(
      `SELECT b.id FROM bags b
        WHERE b.status = 'sealed'
          AND NOT EXISTS (
            SELECT 1 FROM delivery_legs l
             WHERE l."bagId" = b.id
               AND l.status IN ('requested', 'assigned', 'picked_up', 'returning'))
        LIMIT 100`,
    );
    let redispatched = 0;
    for (const bag of waiting) {
      const leg = await this.dataSource.transaction((manager) =>
        this.dispatch.dispatchBag(bag.id, manager),
      );
      redispatched += leg ? 1 : 0;
    }

    const cutoff = new Date(
      now.getTime() - MISSING_FROM_BAG_AFTER_HOURS * 3_600_000,
    );
    const missing = await this.dataSource.query<
      {
        id: string;
        code: string;
        destinationName: string;
        arrivedAt: Date;
        trackingCodes: string[];
      }[]
    >(
      `SELECT b.id, b.code, n.name AS "destinationName", b."arrivedAt",
              array_agg(o."trackingCode" ORDER BY o."trackingCode") AS "trackingCodes"
         FROM bags b
         JOIN nodes n ON n.id = b."destinationNodeId"
         JOIN orders o ON o."bagId" = b.id AND o.status = 'arrived_at_destination'
        WHERE b.status = 'arrived' AND b."arrivedAt" <= $1 AND b."missingAlertedAt" IS NULL
        GROUP BY b.id, n.name
        LIMIT 100`,
      [cutoff],
    );
    for (const bag of missing) {
      await this.dataSource.transaction(async (manager) => {
        await this.alertMissing(bag, manager);
        await manager.query(
          `UPDATE bags SET "missingAlertedAt" = $2 WHERE id = $1`,
          [bag.id, now],
        );
      });
    }
    return { redispatched, missingAlerts: missing.length };
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.run();
      if (result.redispatched || result.missingAlerts) {
        this.logger.log(
          `Bags: ${result.redispatched} re-dispatched, ${result.missingAlerts} missing-parcel alerts`,
        );
      }
    } catch (error) {
      this.logger.error(`Bag sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  // Nothing more goes in; one courier is booked for the whole bag. Parcels
  // that left it while it was open (lost, damaged) aren't counted; an empty
  // bag is simply cancelled.
  private async seal(
    manager: EntityManager,
    bag: BagEntity,
    userId: string | null,
  ): Promise<void> {
    const [{ count }] = await manager.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM orders
        WHERE "bagId" = $1 AND status = 'parcel_received_at_origin'`,
      [bag.id],
    );
    bag.parcelCount = count;
    bag.sealedAt = new Date();
    bag.sealedByUserId = userId;
    bag.status = count > 0 ? BagStatus.SEALED : BagStatus.CANCELLED;
    await manager.save(bag);
    if (count > 0) {
      await this.dispatch.dispatchBag(bag.id, manager);
    }
  }

  private async alertMissing(
    bag: {
      code: string;
      destinationName: string;
      arrivedAt: Date;
      trackingCodes: string[];
    },
    manager: EntityManager,
  ): Promise<void> {
    const ops = (await this.adminPermissions.list()).filter(
      (admin) =>
        String(admin.status) === 'active' &&
        (admin.adminPermissions.includes(AdminPermission.OPS) ||
          admin.adminPermissions.includes(AdminPermission.SUPER)),
    );
    for (const admin of ops) {
      const { html, text } = renderEmail({
        greetingName: admin.firstName,
        heading: `Parcels missing from bag ${bag.code}`,
        blocks: [
          {
            kind: 'details',
            rows: [
              { label: 'Bag', value: bag.code },
              { label: 'At', value: bag.destinationName },
              { label: 'Arrived', value: bag.arrivedAt.toISOString() },
              {
                label: 'Not scanned in',
                value: bag.trackingCodes.join(', '),
              },
            ],
          },
          {
            kind: 'paragraph',
            text: `These parcels were in the bag but haven't been scanned in ${MISSING_FROM_BAG_AFTER_HOURS} hours after it arrived. Check with the Node; record any that are lost.`,
          },
        ],
      });
      await this.outbox.enqueueEmail(
        {
          to: admin.email,
          subject: `Missing from bag ${bag.code}: ${bag.trackingCodes.length} parcel(s)`,
          text,
          html,
        },
        manager,
      );
    }
  }

  private async findForNode(
    userId: string,
    codeInput: string,
    side?: 'origin',
  ): Promise<BagEntity> {
    const code = normaliseBagCode(codeInput);
    const bag = code
      ? await this.dataSource.manager.findOneBy(BagEntity, { code })
      : null;
    const nodeIds = bag
      ? await this.nodeOperators.getNodeIdsForUser(userId)
      : [];
    const allowed =
      bag &&
      (nodeIds.includes(bag.originNodeId) ||
        (side !== 'origin' && nodeIds.includes(bag.destinationNodeId)));
    if (!bag || !allowed) {
      throw new EntityNotFoundException('Bag', codeInput);
    }
    return bag;
  }

  private async views(ids: string[]): Promise<BagView[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.dataSource.query<
      {
        code: string;
        status: BagStatus;
        parcelCount: number;
        sealedAt: Date | null;
        arrivedAt: Date | null;
        unpackedAt: Date | null;
        createdAt: Date;
        originId: string;
        originName: string;
        originCity: string;
        destinationId: string;
        destinationName: string;
        destinationCity: string;
      }[]
    >(
      `SELECT b.code, b.status, b."parcelCount", b."sealedAt", b."arrivedAt",
              b."unpackedAt", b."createdAt",
              o.id AS "originId", o.name AS "originName", o.city AS "originCity",
              d.id AS "destinationId", d.name AS "destinationName", d.city AS "destinationCity"
         FROM bags b
         JOIN nodes o ON o.id = b."originNodeId"
         JOIN nodes d ON d.id = b."destinationNodeId"
        WHERE b.id = ANY($1)
        ORDER BY b."createdAt" DESC`,
      [ids],
    );
    return rows.map((r) => ({
      code: r.code,
      status: r.status,
      origin: { id: r.originId, name: r.originName, city: r.originCity },
      destination: {
        id: r.destinationId,
        name: r.destinationName,
        city: r.destinationCity,
      },
      parcelCount: r.parcelCount,
      sealedAt: r.sealedAt?.toISOString() ?? null,
      arrivedAt: r.arrivedAt?.toISOString() ?? null,
      unpackedAt: r.unpackedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
