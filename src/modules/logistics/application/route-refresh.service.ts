import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxHandlerRegistry } from '../../notifications/application/outbox-handler.registry';
import { OutboxService } from '../../notifications/application/outbox.service';
import { IllegalDeliveryActionException } from '../domain/exceptions/illegal-delivery-action.exception';
import type {
  LogisticsProvider,
  RoutePoint,
} from '../domain/ports/logistics-provider.port';
import { LogisticsProviderRegistry } from './logistics-provider.registry';
import { RouteDistanceService } from './route-distance.service';

export const REFRESH_ROUTES_EVENT_TYPE = 'logistics.refresh_routes';

// Pairs measured per outbox run. Outbox jobs run one at a time, so a run
// is kept short (~45 s at Sendii's pacing) and the job re-queues itself for
// the rest — emails and dispatches get processed in between.
const PAIRS_PER_RUN = 20;

interface RefreshPayload {
  providerKey: string;
  includePending: boolean;
  offset: number;
}

interface NodePair {
  originNodeId: string;
  destinationNodeId: string;
  origin: RoutePoint;
  destination: RoutePoint;
}

export interface RouteRefreshStarted {
  queued: boolean;
  alreadyRunning: boolean;
  providerKey: string;
  pairs: number;
  estimatedSeconds: number;
}

export interface RouteDistanceStatus {
  measuringProvider: string | null;
  refreshRunning: boolean;
  eligiblePairs: number;
  measuredPairs: number;
  lastMeasuredAt: Date | null;
  routes: {
    originNodeId: string;
    originNodeName: string;
    destinationNodeId: string;
    destinationNodeName: string;
    straightLineKm: number;
    roadDistanceKm: number | null;
    source: string | null;
    updatedAt: Date | null;
  }[];
}

// The admin "Refresh routes" action: measures the real road distance
// between every pair of Nodes (both directions) with a courier that can do
// so for free (Sendii quotes), so prices use road kilometres from the first
// order instead of the straight-line estimate. Runs in the background via
// the outbox, paced to the courier's rate limit.
@Injectable()
export class RouteRefreshService implements OnModuleInit {
  private readonly logger = new Logger(RouteRefreshService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: LogisticsProviderRegistry,
    private readonly outboxService: OutboxService,
    private readonly outboxHandlers: OutboxHandlerRegistry,
    private readonly routeDistanceService: RouteDistanceService,
  ) {}

  onModuleInit(): void {
    this.outboxHandlers.register(REFRESH_ROUTES_EVENT_TYPE, {
      handle: (payload) =>
        this.measureChunk(payload as unknown as RefreshPayload),
    });
  }

  async start(options: {
    includePending: boolean;
  }): Promise<RouteRefreshStarted> {
    const provider = await this.measuringProvider();
    if (!provider) {
      throw new IllegalDeliveryActionException(
        'No courier that can measure routes is running here (Sendii needs SENDII_API_KEY)',
      );
    }
    const pairs = await this.pairs(provider.key, options.includePending);
    const estimate = (count: number) =>
      Math.ceil(
        (count * (provider.capabilities.measureRoutePacingMs ?? 0)) / 1000,
      );

    if (await this.isRunning()) {
      return {
        queued: false,
        alreadyRunning: true,
        providerKey: provider.key,
        pairs: pairs.length,
        estimatedSeconds: estimate(pairs.length),
      };
    }
    await this.outboxService.enqueue(REFRESH_ROUTES_EVENT_TYPE, {
      providerKey: provider.key,
      includePending: options.includePending,
      offset: 0,
    } satisfies RefreshPayload);
    return {
      queued: true,
      alreadyRunning: false,
      providerKey: provider.key,
      pairs: pairs.length,
      estimatedSeconds: estimate(pairs.length),
    };
  }

  async status(
    options: { includePending: boolean } = { includePending: false },
  ): Promise<RouteDistanceStatus> {
    const provider = await this.measuringProvider();
    const pairs = await this.pairs(
      provider?.key ?? null,
      options.includePending,
    );
    const routes = await this.dataSource.query<RouteDistanceStatus['routes']>(
      `SELECT a.id AS "originNodeId", a.name AS "originNodeName",
              b.id AS "destinationNodeId", b.name AS "destinationNodeName",
              round((ST_Distance(a.location, b.location) / 1000)::numeric, 2)::float AS "straightLineKm",
              round((r."roadDistanceMeters" / 1000.0)::numeric, 2)::float AS "roadDistanceKm",
              r.source, r."updatedAt"
         FROM nodes a
         JOIN nodes b ON b.id <> a.id
         LEFT JOIN node_route_distances r
           ON r."originNodeId" = a.id AND r."destinationNodeId" = b.id
        WHERE (a.id, b.id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))
        ORDER BY a.name, b.name`,
      [pairs.map((p) => p.originNodeId), pairs.map((p) => p.destinationNodeId)],
    );
    const measured = routes.filter((r) => r.roadDistanceKm !== null);
    return {
      measuringProvider: provider?.key ?? null,
      refreshRunning: await this.isRunning(),
      eligiblePairs: routes.length,
      measuredPairs: measured.length,
      lastMeasuredAt:
        measured
          .map((r) => r.updatedAt!)
          .sort((x, y) => new Date(y).getTime() - new Date(x).getTime())[0] ??
        null,
      routes,
    };
  }

  private async measureChunk(payload: RefreshPayload): Promise<void> {
    const provider = this.registry.get(payload.providerKey);
    if (!provider?.measureRoute) {
      this.logger.warn(
        `Route refresh: ${payload.providerKey} isn't running — skipped`,
      );
      return;
    }
    const pairs = await this.pairs(provider.key, payload.includePending);
    const chunk = pairs.slice(payload.offset, payload.offset + PAIRS_PER_RUN);
    const pacingMs = provider.capabilities.measureRoutePacingMs ?? 0;

    let failures = 0;
    for (const [index, pair] of chunk.entries()) {
      if (index > 0 && pacingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pacingMs));
      }
      try {
        const measured = await provider.measureRoute(
          pair.origin,
          pair.destination,
        );
        if (measured) {
          await this.routeDistanceService.record(
            pair.originNodeId,
            pair.destinationNodeId,
            measured.distanceMeters,
            provider.key,
          );
        }
      } catch (error) {
        failures += 1;
        this.logger.warn(
          `Route refresh: measuring ${pair.originNodeId} → ${pair.destinationNodeId} failed: ${String(error)}`,
        );
      }
    }
    // Every pair failing means the courier is unreachable — let the outbox
    // retry this chunk with backoff instead of carrying on.
    if (chunk.length > 0 && failures === chunk.length) {
      throw new Error(`Route refresh: all ${failures} measurements failed`);
    }

    const next = payload.offset + PAIRS_PER_RUN;
    if (next < pairs.length) {
      await this.outboxService.enqueue(REFRESH_ROUTES_EVENT_TYPE, {
        ...payload,
        offset: next,
      } satisfies RefreshPayload);
    } else {
      this.logger.log(
        `Route refresh with ${provider.key} finished: ${pairs.length} pair(s)`,
      );
    }
  }

  // Ordered pairs of distinct Nodes (directions differ on one-way roads)
  // whose straight-line distance is inside the measuring courier's limits.
  // Active Nodes only by default — only they take orders.
  private async pairs(
    providerKey: string | null,
    includePending: boolean,
  ): Promise<NodePair[]> {
    const rows = await this.dataSource.query<
      {
        originNodeId: string;
        destinationNodeId: string;
        oLat: number;
        oLng: number;
        oAddress: string;
        oCity: string;
        dLat: number;
        dLng: number;
        dAddress: string;
        dCity: string;
      }[]
    >(
      `SELECT a.id AS "originNodeId", b.id AS "destinationNodeId",
              a.latitude AS "oLat", a.longitude AS "oLng", a.address AS "oAddress", a.city AS "oCity",
              b.latitude AS "dLat", b.longitude AS "dLng", b.address AS "dAddress", b.city AS "dCity"
         FROM nodes a
         JOIN nodes b ON b.id <> a.id
         LEFT JOIN logistics_providers p ON p.key = $1
        WHERE a.status = ANY($2) AND b.status = ANY($2)
          AND (p."minDistanceKm" IS NULL
               OR ST_Distance(a.location, b.location) >= p."minDistanceKm" * 1000)
          AND (p."maxDistanceKm" IS NULL
               OR ST_Distance(a.location, b.location) <= p."maxDistanceKm" * 1000)
        ORDER BY a.id, b.id`,
      [providerKey, includePending ? ['active', 'pending'] : ['active']],
    );
    return rows.map((row) => ({
      originNodeId: row.originNodeId,
      destinationNodeId: row.destinationNodeId,
      origin: {
        latitude: row.oLat,
        longitude: row.oLng,
        address: row.oAddress,
        city: row.oCity,
      },
      destination: {
        latitude: row.dLat,
        longitude: row.dLng,
        address: row.dAddress,
        city: row.dCity,
      },
    }));
  }

  // The first enabled-or-not courier, by routing priority, whose adapter
  // can measure routes.
  private async measuringProvider(): Promise<LogisticsProvider | null> {
    const keys = await this.dataSource.query<{ key: string }[]>(
      `SELECT key FROM logistics_providers ORDER BY priority, key`,
    );
    for (const { key } of keys) {
      const provider = this.registry.get(key);
      if (provider?.measureRoute) {
        return provider;
      }
    }
    return null;
  }

  private async isRunning(): Promise<boolean> {
    const [{ count }] = await this.dataSource.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM outbox_events
        WHERE "eventType" = $1 AND status = 'pending'`,
      [REFRESH_ROUTES_EVENT_TYPE],
    );
    return count > 0;
  }
}
