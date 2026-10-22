import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { OutboxService } from '../../notifications/application/outbox.service';
import { IllegalDeliveryActionException } from '../domain/exceptions/illegal-delivery-action.exception';
import { LogisticsProviderUnavailableException } from '../domain/exceptions/logistics-provider-unavailable.exception';
import { LogisticsProviderError } from '../domain/ports/logistics-provider.port';
import type {
  EconomicsQueryDto,
  ListDeliveriesQueryDto,
  UpdateLogisticsProviderDto,
  UpdateVehicleRuleDto,
} from '../interface/dto/admin-logistics.dto';
import { SUBMIT_DELIVERY_EVENT_TYPE } from './delivery-dispatch.service';
import { DeliveryEventsService } from './delivery-events.service';
import { DeliveryReconcilerService } from './delivery-reconciler.service';
import { IN_HOUSE_PROVIDER_KEY } from './in-house-provider-key';
import { LogisticsProviderRegistry } from './logistics-provider.registry';

const ACTIVE = `('requested', 'assigned', 'picked_up', 'returning')`;
const STUCK_AFTER_MINUTES = 30;

export interface AdminProviderView {
  key: string;
  label: string;
  enabled: boolean;
  // An adapter for this key is running in this deployment (e.g. Sendii
  // needs SENDII_API_KEY). Only registered providers are ever routed to.
  registered: boolean;
  priority: number;
  maxAttempts: number;
  assignTimeoutMinutes: number | null;
  minDistanceKm: number | null;
  maxDistanceKm: number | null;
  pilotNodeIds: string[] | null;
  maxCostShare: number | null;
  lowBalanceAlertKobo: number | null;
  capabilities: {
    vehicleClasses: readonly string[];
    handover: string;
    updates: string;
    prepaidWallet: boolean;
  } | null;
  activeDeliveries: number;
}

export interface AdminDeliveryRow {
  id: string;
  orderId: string;
  orderTrackingCode: string;
  orderStatus: string;
  provider: string;
  providerLabel: string;
  legType: string;
  status: string;
  providerStatus: string | null;
  externalId: string | null;
  attemptNumber: number;
  vehicleClass: string | null;
  courierName: string | null;
  courierPhone: string | null;
  quotedKobo: number | null;
  actualKobo: number | null;
  surchargeKobo: number;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
}

export interface EconomicsRow {
  orderId: string;
  orderTrackingCode: string;
  orderStatus: string;
  providers: string[];
  customerPaidKobo: number;
  deliveryFeeKobo: number;
  // What the courier(s) charged (or, while unsettled, are quoted to charge)
  // including surcharges; cancelled attempts cost nothing.
  courierCostKobo: number;
  // The rider share the courier is measured against (recorded at
  // collection, else estimated from the current split rule).
  courierAllocationKobo: number;
  allocationEstimated: boolean;
  // allocation − cost: positive = the 60% covered the courier.
  marginKobo: number;
  settled: boolean;
  createdAt: Date;
}

// Back-office control of the courier layer (phase 6): routing settings,
// vehicle rules, the delivery list with manual interventions, and courier
// economics. Every change here is an Admin action on live routing.
@Injectable()
export class AdminLogisticsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: LogisticsProviderRegistry,
    private readonly deliveryEventsService: DeliveryEventsService,
    private readonly reconciler: DeliveryReconcilerService,
    private readonly outboxService: OutboxService,
  ) {}

  // ── Providers ──────────────────────────────────────────────────────────

  async listProviders(): Promise<AdminProviderView[]> {
    const rows = await this.dataSource.query<
      (Omit<AdminProviderView, 'registered' | 'capabilities'> & {
        activeDeliveries: number;
      })[]
    >(
      `SELECT p.key, p.label, p.enabled, p.priority, p."maxAttempts",
              p."assignTimeoutMinutes", p."minDistanceKm", p."maxDistanceKm",
              p."pilotNodeIds", p."maxCostShare", p."lowBalanceAlertKobo",
              (SELECT COUNT(*)::int FROM delivery_legs l
                WHERE l."providerKey" = p.key AND l.status IN ${ACTIVE})
                AS "activeDeliveries"
         FROM logistics_providers p
        ORDER BY p.priority, p.key`,
    );
    return rows.map((row) => {
      const adapter = this.registry.get(row.key);
      return {
        ...row,
        registered: !!adapter,
        capabilities: adapter
          ? {
              vehicleClasses: adapter.capabilities.vehicleClasses,
              handover: adapter.capabilities.handover,
              updates: adapter.capabilities.updates,
              prepaidWallet: adapter.capabilities.prepaidWallet,
            }
          : null,
      };
    });
  }

  async updateProvider(
    key: string,
    dto: UpdateLogisticsProviderDto,
  ): Promise<AdminProviderView> {
    const current = (await this.listProviders()).find((p) => p.key === key);
    if (!current) {
      throw new EntityNotFoundException('LogisticsProvider', key);
    }
    if (key === IN_HOUSE_PROVIDER_KEY && dto.enabled === false) {
      throw new IllegalDeliveryActionException(
        "Locoomo riders are every order's fallback and can't be switched off",
      );
    }

    // Sent = not undefined. (Not `field in dto`: the DTO class declares
    // every field, so unsent ones exist as undefined.) null is a real value
    // here — it clears the setting.
    const has = (field: keyof UpdateLogisticsProviderDto) =>
      dto[field] !== undefined;
    const minKm = has('minDistanceKm')
      ? dto.minDistanceKm!
      : current.minDistanceKm;
    const maxKm = has('maxDistanceKm')
      ? dto.maxDistanceKm!
      : current.maxDistanceKm;
    if (minKm != null && maxKm != null && minKm > maxKm) {
      throw this.invalid(
        'minDistanceKm',
        'minDistanceKm must not exceed maxDistanceKm',
      );
    }
    if (dto.pilotNodeIds?.length) {
      const [{ count }] = await this.dataSource.query<{ count: number }[]>(
        `SELECT COUNT(*)::int AS count FROM nodes WHERE id = ANY($1)`,
        [dto.pilotNodeIds],
      );
      if (count !== dto.pilotNodeIds.length) {
        throw this.invalid(
          'pilotNodeIds',
          'pilotNodeIds contains unknown Nodes',
        );
      }
    }

    const changes: Record<string, unknown> = {};
    for (const field of [
      'enabled',
      'priority',
      'maxAttempts',
      'assignTimeoutMinutes',
      'minDistanceKm',
      'maxDistanceKm',
      'maxCostShare',
    ] as const) {
      if (has(field)) {
        changes[field] = dto[field] ?? null;
      }
    }
    if (has('pilotNodeIds')) {
      changes.pilotNodeIds = dto.pilotNodeIds?.length ? dto.pilotNodeIds : null;
    }
    if (has('lowBalanceAlertNaira')) {
      changes.lowBalanceAlertKobo =
        dto.lowBalanceAlertNaira == null
          ? null
          : Math.round(dto.lowBalanceAlertNaira * 100);
    }

    const columns = Object.keys(changes);
    if (columns.length > 0) {
      await this.dataSource.query(
        `UPDATE logistics_providers
            SET ${columns.map((c, i) => `"${c}" = $${i + 2}`).join(', ')},
                "updatedAt" = now()
          WHERE key = $1`,
        [key, ...columns.map((c) => changes[c])],
      );
    }
    return (await this.listProviders()).find((p) => p.key === key)!;
  }

  // ── Vehicle rules ──────────────────────────────────────────────────────

  listVehicleRules(): Promise<Record<string, unknown>[]> {
    return this.dataSource.query(
      `SELECT "vehicleClass", rank, enabled, "parcelSizes",
              "maxWeightKg"::float AS "maxWeightKg", "maxLongestSideCm", "updatedAt"
         FROM vehicle_class_rules ORDER BY rank`,
    );
  }

  async updateVehicleRule(
    vehicleClass: string,
    dto: UpdateVehicleRuleDto,
  ): Promise<Record<string, unknown>> {
    const changes = Object.entries(dto as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    );
    if (changes.length > 0) {
      await this.dataSource.query(
        `UPDATE vehicle_class_rules
            SET ${changes.map(([c], i) => `"${c}" = $${i + 2}`).join(', ')},
                "updatedAt" = now()
          WHERE "vehicleClass" = $1`,
        [vehicleClass, ...changes.map(([, value]) => value)],
      );
    }
    const rule = (await this.listVehicleRules()).find(
      (r) => r.vehicleClass === vehicleClass,
    );
    if (!rule) {
      throw new EntityNotFoundException('VehicleClassRule', vehicleClass);
    }
    return rule;
  }

  // ── Deliveries ─────────────────────────────────────────────────────────

  async listDeliveries(
    query: ListDeliveriesQueryDto,
  ): Promise<PaginatedResultDto<AdminDeliveryRow>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.status) conditions.push(`l.status = ${param(query.status)}`);
    if (query.provider)
      conditions.push(`l."providerKey" = ${param(query.provider)}`);
    if (query.from) conditions.push(`l."createdAt" >= ${param(query.from)}`);
    if (query.to) conditions.push(`l."createdAt" < ${param(query.to)}`);
    if (query.stuck) {
      conditions.push(
        `l.status IN ${ACTIVE} AND l."updatedAt" < now() - ${param(STUCK_AFTER_MINUTES)} * interval '1 minute'`,
      );
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const items = await this.dataSource.query<AdminDeliveryRow[]>(
      `${this.deliverySelect()} ${where}
        ORDER BY l."createdAt" DESC
        LIMIT ${param(query.limit)} OFFSET ${param((query.page - 1) * query.limit)}`,
      params,
    );
    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM delivery_legs l ${where}`,
      params.slice(0, params.length - 2),
    );
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }

  // A delivery the courier never received (its submission kept failing):
  // send it again.
  async retry(legId: string): Promise<AdminDeliveryRow> {
    const leg = await this.getDelivery(legId);
    const adapter = this.registry.get(leg.provider);
    if (
      leg.status !== 'requested' ||
      leg.externalId ||
      !adapter?.capabilities.remoteSubmission
    ) {
      throw new IllegalDeliveryActionException(
        'Only a delivery that never reached its courier can be retried — use reconcile to refresh one the courier has',
      );
    }
    await this.outboxService.enqueue(SUBMIT_DELIVERY_EVENT_TYPE, {
      legId,
    });
    return leg;
  }

  // Take the order away from an external courier (cancelling with them if
  // they still allow it) and give it to Locoomo riders.
  async fallbackToInHouse(legId: string): Promise<AdminDeliveryRow> {
    const leg = await this.getDelivery(legId);
    if (leg.provider === IN_HOUSE_PROVIDER_KEY) {
      throw new IllegalDeliveryActionException(
        'This delivery is already with Locoomo riders',
      );
    }
    if (leg.status !== 'requested' && leg.status !== 'assigned') {
      throw new IllegalDeliveryActionException(
        `Can't take a delivery back once it's ${leg.status}`,
      );
    }

    const adapter = this.registry.get(leg.provider);
    if (adapter && leg.externalId) {
      try {
        await adapter.cancel(leg.externalId);
      } catch (error) {
        if (error instanceof LogisticsProviderError && !error.retryable) {
          throw new IllegalDeliveryActionException(
            `${leg.providerLabel} no longer allows cancelling this delivery — reconcile to see where it is`,
          );
        }
        throw this.providerDown(leg.provider, 'cancel', error);
      }
    }
    const moved = await this.dataSource.transaction((manager) =>
      this.deliveryEventsService.cancelLeg(legId, 'admin_fallback', manager, {
        thenRouteTo: IN_HOUSE_PROVIDER_KEY,
      }),
    );
    if (!moved) {
      throw new IllegalDeliveryActionException(
        'The delivery moved on while being cancelled — reconcile and check again',
      );
    }
    return this.getDelivery(legId);
  }

  async reconcile(legId: string): Promise<AdminDeliveryRow> {
    const leg = await this.getDelivery(legId);
    if (!leg.externalId || !this.registry.get(leg.provider)?.getDelivery) {
      throw new IllegalDeliveryActionException(
        'Only a delivery booked with an external courier can be reconciled',
      );
    }
    try {
      await this.reconciler.reconcileNow(legId);
    } catch (error) {
      throw this.providerDown(leg.provider, 'getDelivery', error);
    }
    return this.getDelivery(legId);
  }

  // ── Economics ──────────────────────────────────────────────────────────

  async economics(query: EconomicsQueryDto): Promise<{
    items: EconomicsRow[];
    page: number;
    limit: number;
    total: number;
    totals: {
      orders: number;
      customerPaidKobo: number;
      courierCostKobo: number;
      courierAllocationKobo: number;
      marginKobo: number;
    };
  }> {
    const conditions = [`l."providerKey" <> '${IN_HOUSE_PROVIDER_KEY}'`];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.provider)
      conditions.push(`l."providerKey" = ${param(query.provider)}`);
    if (query.from) conditions.push(`o."createdAt" >= ${param(query.from)}`);
    if (query.to) conditions.push(`o."createdAt" < ${param(query.to)}`);

    const [rule] = await this.dataSource.query<{ riderPercent: number }[]>(
      `SELECT "riderPercent" FROM revenue_split_rules
        WHERE "effectiveFrom" <= now() ORDER BY "effectiveFrom" DESC LIMIT 1`,
    );
    const riderShare = (rule?.riderPercent ?? 60) / 100;

    // One row per order that used an external courier.
    const perOrder = `
      SELECT o.id AS "orderId", o."trackingCode" AS "orderTrackingCode",
             o.status AS "orderStatus", o."amountKobo" AS "customerPaidKobo",
             o."amountKobo" - o."destinationFeeKobo" AS "deliveryFeeKobo",
             o."createdAt",
             array_agg(DISTINCT l."providerKey") AS providers,
             SUM(CASE
                   WHEN l."actualKobo" IS NOT NULL THEN l."actualKobo"
                   WHEN l.status IN ${ACTIVE} THEN COALESCE(l."quotedKobo", 0)
                   ELSE 0
                 END + l."surchargeKobo")::int AS "courierCostKobo",
             bool_or(l."actualKobo" IS NOT NULL) AS settled,
             (SELECT e."amountKobo" FROM revenue_split_entries e
               WHERE e."orderId" = o.id AND e."partyType" = 'courier_allocation'
               LIMIT 1) AS "recordedAllocationKobo"
        FROM orders o
        JOIN delivery_legs l ON l."orderId" = o.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY o.id`;

    const toRow = (
      r: Omit<
        EconomicsRow,
        'courierAllocationKobo' | 'allocationEstimated' | 'marginKobo'
      > & {
        recordedAllocationKobo: number | null;
      },
    ): EconomicsRow => {
      const estimated = r.recordedAllocationKobo === null;
      const allocation =
        r.recordedAllocationKobo ?? Math.floor(r.deliveryFeeKobo * riderShare);
      return {
        orderId: r.orderId,
        orderTrackingCode: r.orderTrackingCode,
        orderStatus: r.orderStatus,
        providers: r.providers,
        customerPaidKobo: r.customerPaidKobo,
        deliveryFeeKobo: r.deliveryFeeKobo,
        courierCostKobo: r.courierCostKobo,
        settled: r.settled,
        createdAt: r.createdAt,
        courierAllocationKobo: allocation,
        allocationEstimated: estimated,
        marginKobo: allocation - r.courierCostKobo,
      };
    };

    const all = (
      await this.dataSource.query<Parameters<typeof toRow>[0][]>(
        `${perOrder} ORDER BY o."createdAt" DESC`,
        params,
      )
    ).map(toRow);
    const offset = (query.page - 1) * query.limit;
    const sum = (field: keyof EconomicsRow) =>
      all.reduce((total, row) => total + (row[field] as number), 0);

    return {
      items: all.slice(offset, offset + query.limit),
      page: query.page,
      limit: query.limit,
      total: all.length,
      totals: {
        orders: all.length,
        customerPaidKobo: sum('customerPaidKobo'),
        courierCostKobo: sum('courierCostKobo'),
        courierAllocationKobo: sum('courierAllocationKobo'),
        marginKobo: sum('marginKobo'),
      },
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async getDelivery(legId: string): Promise<AdminDeliveryRow> {
    const [row] = await this.dataSource.query<AdminDeliveryRow[]>(
      `${this.deliverySelect()} WHERE l.id = $1`,
      [legId],
    );
    if (!row) {
      throw new EntityNotFoundException('Delivery', legId);
    }
    return row;
  }

  private deliverySelect(): string {
    return `
      SELECT l.id, l."orderId", o."trackingCode" AS "orderTrackingCode",
             o.status AS "orderStatus", l."providerKey" AS provider,
             p.label AS "providerLabel", l."legType", l.status, l."providerStatus",
             l."externalId", l."attemptNumber", l."vehicleClass", l."courierName",
             l."courierPhone", l."quotedKobo", l."actualKobo", l."surchargeKobo",
             l."failureReason", l."createdAt", l."updatedAt", l."endedAt"
        FROM delivery_legs l
        JOIN orders o ON o.id = l."orderId"
        JOIN logistics_providers p ON p.key = l."providerKey"`;
  }

  private invalid(field: string, message: string): BadRequestException {
    return new BadRequestException({
      message: 'Validation failed',
      details: [{ field, constraint: 'consistency', message }],
    });
  }

  private providerDown(providerKey: string, operation: string, error: unknown) {
    return new LogisticsProviderUnavailableException(
      providerKey,
      operation,
      error instanceof Error ? error.message : String(error),
    );
  }
}
