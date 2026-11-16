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
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import type { Env } from '../../../config/env.validation';
import { NodesService } from '../../nodes/application/nodes.service';
import { OrdersService } from '../../orders/application/orders.service';
import { PublicHolidayService } from '../../orders/application/public-holiday.service';
import {
  RerouteNotPendingException,
  RerouteTargetUnavailableException,
} from '../domain/exceptions/bag.exceptions';
import { BagService } from './bag.service';
import { ReceiverNotificationService } from './receiver-notification.service';

const INTERVAL_NAME = 'reroutes';
const INTERVAL_MS = 10 * 60_000;
// Ops get this long to choose before the system picks the nearest Node.
const AUTO_AFTER_WORKING_DAYS = 1;

export interface RerouteCandidate {
  nodeId: string;
  name: string;
  address: string;
  city: string;
  distanceKm: number;
  // Free space (capacity minus what's held there).
  headroom: number;
}

export interface RerouteQueueItem {
  orderId: string;
  trackingCode: string;
  merchantId: string | null;
  merchantName: string | null;
  reason: string | null;
  state: 'pending' | 'resolved';
  auto: boolean;
  requestedAt: string | null;
  resolvedAt: string | null;
  ageMinutes: number | null;
  origin: { id: string; name: string };
  destination: { id: string; name: string; city: string };
  candidates: RerouteCandidate[];
}

interface OrderRow {
  id: string;
  trackingCode: string;
  status: string;
  source: string;
  merchantId: string | null;
  originNodeId: string;
  destinationNodeId: string;
  receiverEmail: string | null;
  parcelDescription: string;
  rerouteState: string;
}

// The reroute queue (plan §6.5, D15, M5c). A merchant parcel dropped off
// while its destination Node is full or closed doesn't go anywhere: it
// waits at its origin (no courier, no bag) and its destination slot is
// let go. Ops pick another Node; if nobody does within a working day, the
// nearest Node with room is picked automatically and flagged for review.
// Then the buyer is told, the merchant gets shipment.destination_changed,
// and the parcel goes on its way (bagged at a hub, else its own courier).
// Locoomo absorbs any price difference.
@Injectable()
export class RerouteService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RerouteService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrdersService,
    private readonly nodes: NodesService,
    private readonly bags: BagService,
    private readonly receiverNotifications: ReceiverNotificationService,
    private readonly holidays: PublicHolidayService,
    private readonly audit: AuditService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
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

  // Inside the drop-off transaction, after the parcel was received (and
  // its destination slot held). True when it must wait for a reroute.
  async holdIfDestinationBlocked(
    order: { id: string; source: string | null; destinationNodeId: string },
    manager: EntityManager,
  ): Promise<boolean> {
    if (order.source !== 'merchant') {
      // Consumer orders reserved space at checkout.
      return false;
    }
    const [node] = await manager.query<
      {
        status: string;
        capacity: number;
        currentCount: number;
        destinationHeldCount: number;
      }[]
    >(
      `SELECT status, capacity, "currentCount", "destinationHeldCount"
         FROM nodes WHERE id = $1`,
      [order.destinationNodeId],
    );
    const reason =
      node.status !== 'active'
        ? 'destination_unavailable'
        : node.currentCount + node.destinationHeldCount > node.capacity
          ? 'destination_full'
          : null;
    if (!reason) {
      return false;
    }
    await this.releaseDestinationSlot(order.id, manager);
    await this.orders.markRerouteRequired(order.id, reason, manager);
    return true;
  }

  // Ops queue: waiting parcels (oldest first) with the three nearest Nodes
  // that have room; or recently auto-rerouted ones, to review.
  async queue(state: 'pending' | 'auto'): Promise<RerouteQueueItem[]> {
    const rows = await this.dataSource.query<
      {
        orderId: string;
        trackingCode: string;
        merchantId: string | null;
        merchantName: string | null;
        reason: string | null;
        state: 'pending' | 'resolved';
        auto: boolean;
        requestedAt: Date | null;
        resolvedAt: Date | null;
        originId: string;
        originName: string;
        destinationId: string;
        destinationName: string;
        destinationCity: string;
      }[]
    >(
      `SELECT o.id AS "orderId", o."trackingCode", o."merchantId",
              m."tradingName" AS "merchantName", o."rerouteReason" AS reason,
              o."rerouteState" AS state, o."rerouteAuto" AS auto,
              o."rerouteRequestedAt" AS "requestedAt", o."rerouteResolvedAt" AS "resolvedAt",
              origin.id AS "originId", origin.name AS "originName",
              dest.id AS "destinationId", dest.name AS "destinationName", dest.city AS "destinationCity"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
         LEFT JOIN merchants m ON m.id = o."merchantId"
        WHERE ${
          state === 'pending'
            ? `o."rerouteState" = 'pending'`
            : `o."rerouteState" = 'resolved' AND o."rerouteAuto"
               AND o."rerouteResolvedAt" > now() - interval '7 days'`
        }
        ORDER BY o."rerouteRequestedAt"
        LIMIT 200`,
    );
    const now = Date.now();
    return Promise.all(
      rows.map(async (row) => ({
        orderId: row.orderId,
        trackingCode: row.trackingCode,
        merchantId: row.merchantId,
        merchantName: row.merchantName,
        reason: row.reason,
        state: row.state,
        auto: row.auto,
        requestedAt: row.requestedAt?.toISOString() ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        ageMinutes: row.requestedAt
          ? Math.floor((now - row.requestedAt.getTime()) / 60_000)
          : null,
        origin: { id: row.originId, name: row.originName },
        destination: {
          id: row.destinationId,
          name: row.destinationName,
          city: row.destinationCity,
        },
        candidates:
          row.state === 'pending'
            ? await this.candidates(
                this.dataSource.manager,
                row.destinationId,
                row.originId,
              )
            : [],
      })),
    );
  }

  async resolve(
    adminUserId: string,
    orderId: string,
    input: { destinationNodeId: string; reason: string },
    context: AuditRequestContext,
  ): Promise<{ orderId: string; destinationNodeId: string }> {
    await this.dataSource.transaction(async (manager) => {
      const order = await this.lockPending(manager, orderId);
      const [target] = await manager.query<
        { status: string; capacity: number; held: number }[]
      >(
        `SELECT status, capacity, "currentCount" + "destinationHeldCount" AS held
           FROM nodes WHERE id = $1`,
        [input.destinationNodeId],
      );
      if (
        !target ||
        target.status !== 'active' ||
        target.held >= target.capacity ||
        input.destinationNodeId === order.originNodeId ||
        input.destinationNodeId === order.destinationNodeId
      ) {
        throw new RerouteTargetUnavailableException();
      }
      await this.move(manager, order, input.destinationNodeId, {
        auto: false,
        adminUserId,
        reason: input.reason,
      });
      await this.audit.record(
        {
          actor: { type: 'user', id: adminUserId, role: 'admin' },
          action: 'order.rerouted',
          merchantId: order.merchantId,
          target: { type: 'order', id: orderId },
          before: { destinationNodeId: order.destinationNodeId },
          after: { destinationNodeId: input.destinationNodeId },
          metadata: { reason: input.reason },
          context,
        },
        manager,
      );
    });
    return { orderId, destinationNodeId: input.destinationNodeId };
  }

  // Parcels waiting longer than a working day go to the nearest Node with
  // room (flagged auto for review). None near? They keep waiting.
  async run(now = new Date()): Promise<{ rerouted: number }> {
    const pending = await this.dataSource.query<
      { id: string; requestedAt: Date }[]
    >(
      `SELECT id, "rerouteRequestedAt" AS "requestedAt" FROM orders
        WHERE "rerouteState" = 'pending'
        ORDER BY "rerouteRequestedAt" LIMIT 100`,
    );
    let rerouted = 0;
    for (const item of pending) {
      const due = await this.holidays.addWorkingDays(
        item.requestedAt,
        AUTO_AFTER_WORKING_DAYS,
      );
      if (due > now) {
        continue;
      }
      const moved = await this.dataSource.transaction(async (manager) => {
        const order = await this.lockPending(manager, item.id).catch(
          () => null,
        );
        if (!order) {
          return false;
        }
        const [best] = await this.candidates(
          manager,
          order.destinationNodeId,
          order.originNodeId,
        );
        if (!best) {
          this.logger.warn(
            `Order ${order.id}: no Node with room near its destination; still waiting`,
          );
          return false;
        }
        await this.move(manager, order, best.nodeId, {
          auto: true,
          adminUserId: null,
          reason: 'auto: no decision within a working day',
        });
        return true;
      });
      rerouted += moved ? 1 : 0;
    }
    return { rerouted };
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const { rerouted } = await this.run();
      if (rerouted) {
        this.logger.log(`Reroutes: ${rerouted} parcel(s) moved automatically`);
      }
    } catch (error) {
      this.logger.error(`Reroute sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  // New destination, slot there, buyer told, and on its way.
  private async move(
    manager: EntityManager,
    order: OrderRow,
    destinationNodeId: string,
    by: { auto: boolean; adminUserId: string | null; reason: string },
  ): Promise<void> {
    const moved = await this.orders.changeDestination(
      order.id,
      destinationNodeId,
      manager,
      by,
    );
    await this.receiverNotifications.enqueueDestinationChanged(moved, manager);
    await this.bags.sendOnward(moved, manager);
  }

  private async lockPending(
    manager: EntityManager,
    orderId: string,
  ): Promise<OrderRow> {
    const [order] = await manager.query<OrderRow[]>(
      `SELECT id, "trackingCode", status, source, "merchantId", "originNodeId",
              "destinationNodeId", "receiverEmail", "parcelDescription", "rerouteState"
         FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!order) {
      throw new EntityNotFoundException('Order', orderId);
    }
    if (
      order.rerouteState !== 'pending' ||
      order.status !== 'parcel_received_at_origin'
    ) {
      throw new RerouteNotPendingException();
    }
    return order;
  }

  // Nearest active Nodes to the original destination with free space,
  // never the origin.
  private candidates(
    manager: EntityManager,
    destinationNodeId: string,
    originNodeId: string,
  ): Promise<RerouteCandidate[]> {
    return manager
      .query<RerouteCandidate[]>(
        `SELECT n.id AS "nodeId", n.name, n.address, n.city,
                round((ST_Distance(n.location, d.location) / 1000)::numeric, 1)::float8 AS "distanceKm",
                n.capacity - n."currentCount" - n."destinationHeldCount" AS headroom
           FROM nodes n, nodes d
          WHERE d.id = $1 AND n.id <> d.id AND n.id <> $2
            AND n.status = 'active' AND n.location IS NOT NULL
            AND n."currentCount" + n."destinationHeldCount" < n.capacity
          ORDER BY ST_Distance(n.location, d.location)
          LIMIT 3`,
        [destinationNodeId, originNodeId],
      )
      .then((rows) =>
        rows.map((r) => ({ ...r, headroom: Number(r.headroom) })),
      );
  }

  // Same idempotent flag DestinationCapacitySubscriber uses, so the new
  // destination's hold (on destination_changed) happens exactly once.
  private async releaseDestinationSlot(
    orderId: string,
    manager: EntityManager,
  ): Promise<void> {
    const [rows] = await manager.query<
      [{ destinationNodeId: string }[], number]
    >(
      `UPDATE orders SET "destinationSlotHeld" = false
        WHERE id = $1 AND "destinationSlotHeld"
        RETURNING "destinationNodeId"`,
      [orderId],
    );
    if (rows[0]) {
      await this.nodes.releaseDestinationSlot(
        rows[0].destinationNodeId,
        manager,
      );
    }
  }
}
