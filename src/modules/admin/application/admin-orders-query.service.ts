import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { signToken, verifyToken } from '../../../common/crypto/signed-token';
import { csvRow, nairaPlain } from '../../../common/csv/csv';
import {
  BusinessException,
  EntityNotFoundException,
} from '../../../common/exceptions';
import type { Env } from '../../../config/env.validation';
import {
  CursorPage,
  CursorPosition,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import { normalizeTrackingCode } from '../../orders/application/tracking-code-input';

export interface AdminOrderFilter {
  source?: 'consumer' | 'merchant';
  merchantId?: string;
  status?: string;
  // Origin or destination.
  nodeId?: string;
  trackingCode?: string;
  // A merchant's own reference (merchant parcels).
  reference?: string;
  rerouteState?: 'pending' | 'resolved';
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

export interface AdminOrderRow {
  id: string;
  trackingCode: string;
  source: string;
  status: string;
  merchant: { id: string; name: string } | null;
  reference: string | null;
  origin: { id: string; name: string };
  destination: { id: string; name: string };
  amountKobo: number;
  rerouteState: string;
  bagCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOrderDetail extends AdminOrderRow {
  // Masked: support sees enough to confirm who they're talking to.
  receiver: { name: string; phone: string; email: string | null };
  shelfNumber: number | null;
  collectionDeadlineAt: string | null;
  returnReason: string | null;
  refusal: Record<string, unknown> | null;
  exception: Record<string, unknown> | null;
  shipment: { id: string; mode: string; status: string } | null;
  events: { type: string; payload: Record<string, unknown>; at: string }[];
  deliveries: {
    id: string;
    viaBag: boolean;
    legType: string;
    provider: string;
    status: string;
    courierName: string | null;
    createdAt: string;
    endedAt: string | null;
  }[];
}

interface RawRow {
  id: string;
  trackingCode: string;
  source: string;
  status: string;
  merchantId: string | null;
  merchantName: string | null;
  reference: string | null;
  originId: string;
  originName: string;
  destinationId: string;
  destinationName: string;
  amountKobo: number;
  rerouteState: string;
  bagCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ms = cursorTime('o."createdAt"');
const EXPORT_PURPOSE = 'admin-orders-export';
const EXPORT_PAGE = 2_000;
const MAX_EXPORT_DAYS = 93;

export class ExportRangeException extends BusinessException {
  readonly errorCode = 'REPORT_RANGE_INVALID';
  readonly httpStatus = 422;

  constructor() {
    super(
      `Pick a date range (from before to) of at most ${MAX_EXPORT_DAYS} days`,
    );
  }
}

export class ExportLinkException extends BusinessException {
  readonly errorCode = 'EXPORT_LINK_INVALID';
  readonly httpStatus = 403;

  constructor() {
    super(
      'This download link is invalid or has expired. Create the export again.',
    );
  }
}

// Admin app › All orders (plan §10): consumer and merchant parcels in one
// list for ops and support, with the filters they search by. Read-only.
@Injectable()
export class AdminOrdersQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  async list(filter: AdminOrderFilter): Promise<CursorPage<AdminOrderRow>> {
    const params: unknown[] = [filter.limit + 1];
    const where = this.conditions(filter, params);
    const after = decodeCursor(filter.cursor);
    if (after) {
      params.push(after.t, after.id);
      where.push(
        `(${ms}, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows = await this.rows(
      `${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${ms} DESC, o.id DESC LIMIT $1`,
      params,
    );
    return toCursorPage<RawRow, AdminOrderRow>(
      rows,
      filter.limit,
      (row): CursorPosition => ({ t: row.createdAt.toISOString(), id: row.id }),
      (row) => this.view(row),
    );
  }

  // The list as CSV through a 15-minute signed link (≤ 93 days; no
  // receiver contact details).
  async createExport(
    adminUserId: string,
    filter: Omit<AdminOrderFilter, 'limit' | 'cursor'> & {
      from: string;
      to: string;
    },
    now = new Date(),
  ): Promise<{ downloadPath: string; expiresAt: string }> {
    const from = new Date(filter.from);
    const to = new Date(filter.to);
    if (
      !(from < to) ||
      to.getTime() - from.getTime() > MAX_EXPORT_DAYS * 86_400_000
    ) {
      throw new ExportRangeException();
    }
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    const token = signToken(
      this.secret(),
      EXPORT_PURPOSE,
      { ...filter },
      expiresAt,
    );
    await this.audit.record({
      actor: { type: 'user', id: adminUserId, role: 'admin' },
      action: 'admin.orders_exported',
      metadata: { ...filter },
    });
    return {
      downloadPath: `/api/v1/admin/exports/orders/download?token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async streamExport(token: string, res: Response): Promise<void> {
    const filter = verifyToken<
      Omit<AdminOrderFilter, 'limit'> & Record<string, unknown>
    >(this.secret(), EXPORT_PURPOSE, token);
    if (!filter) {
      throw new ExportLinkException();
    }
    const day = (value: unknown): string =>
      typeof value === 'string' ? value.slice(0, 10) : '';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="locoomo-orders-${day(filter.from)}-to-${day(filter.to)}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.write(
      csvRow([
        'created_at',
        'tracking_code',
        'source',
        'merchant',
        'reference',
        'status',
        'origin',
        'destination',
        'amount_ngn',
        'reroute_state',
        'bag',
      ]),
    );
    let after: { t: Date; id: string } | null = null;
    for (;;) {
      const params: unknown[] = [EXPORT_PAGE];
      const where = this.conditions({ ...filter, limit: 0 }, params);
      if (after) {
        params.push(after.t, after.id);
        where.push(
          `(o."createdAt", o.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const page = await this.rows(
        `${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY o."createdAt", o.id LIMIT $1`,
        params,
      );
      for (const row of page) {
        res.write(
          csvRow([
            row.createdAt.toISOString(),
            row.trackingCode,
            row.source,
            row.merchantName,
            row.reference,
            row.status,
            row.originName,
            row.destinationName,
            nairaPlain(Number(row.amountKobo)),
            row.rerouteState,
            row.bagCode,
          ]),
        );
      }
      if (page.length < EXPORT_PAGE) {
        break;
      }
      const last = page[page.length - 1];
      after = { t: last.createdAt, id: last.id };
    }
    res.end();
  }

  private secret(): string {
    return this.config.get('JWT_ACCESS_SECRET', { infer: true });
  }

  // The list's filters as SQL conditions; values appended to `params`.
  private conditions(filter: AdminOrderFilter, params: unknown[]): string[] {
    const where: string[] = [];
    const add = (sql: (p: string) => string, value: unknown): void => {
      params.push(value);
      where.push(sql(`$${params.length}`));
    };
    if (filter.source) add((p) => `o.source = ${p}`, filter.source);
    if (filter.merchantId)
      add((p) => `o."merchantId" = ${p}`, filter.merchantId);
    if (filter.status) add((p) => `o.status::text = ${p}`, filter.status);
    if (filter.nodeId) {
      add(
        (p) => `(o."originNodeId" = ${p} OR o."destinationNodeId" = ${p})`,
        filter.nodeId,
      );
    }
    if (filter.trackingCode !== undefined) {
      // An unparseable code matches nothing rather than everything.
      add(
        (p) => `o."trackingCode" = ${p}`,
        normalizeTrackingCode(filter.trackingCode) ?? '',
      );
    }
    if (filter.reference) add((p) => `s.reference = ${p}`, filter.reference);
    if (filter.rerouteState) {
      add((p) => `o."rerouteState" = ${p}`, filter.rerouteState);
    }
    if (filter.from)
      add((p) => `o."createdAt" >= ${p}::timestamptz`, filter.from);
    if (filter.to) add((p) => `o."createdAt" < ${p}::timestamptz`, filter.to);
    return where;
  }

  async detail(id: string): Promise<AdminOrderDetail> {
    const [row] = await this.rows(`WHERE o.id = $1`, [id]);
    if (!row) {
      throw new EntityNotFoundException('Order', id);
    }
    const [extra] = await this.dataSource.query<
      {
        receiverFullName: string;
        receiverPhone: string;
        receiverEmail: string | null;
        shelfNumber: number | null;
        collectionDeadlineAt: Date | null;
        returnReason: string | null;
        refusal: Record<string, unknown> | null;
        exception: Record<string, unknown> | null;
        bagId: string | null;
        shipmentId: string | null;
        shipmentMode: string | null;
        shipmentStatus: string | null;
      }[]
    >(
      `SELECT o."receiverFullName", o."receiverPhone", o."receiverEmail",
              o."shelfNumber", o."collectionDeadlineAt", o."returnReason",
              o.refusal, o.exception, o."bagId",
              s.id AS "shipmentId", s.mode AS "shipmentMode", s.status AS "shipmentStatus"
         FROM orders o
         LEFT JOIN merchant_shipments s ON s."orderId" = o.id
        WHERE o.id = $1`,
      [id],
    );
    const events = await this.dataSource.query<
      { type: string; payload: Record<string, unknown>; createdAt: Date }[]
    >(
      `SELECT type, payload, "createdAt" FROM order_events
        WHERE "orderId" = $1 ORDER BY "createdAt", id`,
      [id],
    );
    const legs = await this.dataSource.query<
      {
        id: string;
        viaBag: boolean;
        legType: string;
        providerKey: string;
        status: string;
        courierName: string | null;
        createdAt: Date;
        endedAt: Date | null;
      }[]
    >(
      `SELECT l.id, (l."bagId" IS NOT NULL) AS "viaBag", l."legType", l."providerKey",
              l.status, l."courierName", l."createdAt", l."endedAt"
         FROM delivery_legs l
        WHERE l."orderId" = $1 OR ($2::uuid IS NOT NULL AND l."bagId" = $2::uuid)
        ORDER BY l."createdAt"`,
      [id, extra.bagId],
    );
    return {
      ...this.view(row),
      receiver: {
        name: extra.receiverFullName,
        phone: maskPhone(extra.receiverPhone),
        email: extra.receiverEmail ? maskEmail(extra.receiverEmail) : null,
      },
      shelfNumber: extra.shelfNumber,
      collectionDeadlineAt: extra.collectionDeadlineAt?.toISOString() ?? null,
      returnReason: extra.returnReason,
      refusal: extra.refusal,
      exception: extra.exception,
      shipment: extra.shipmentId
        ? {
            id: extra.shipmentId,
            mode: extra.shipmentMode!,
            status: extra.shipmentStatus!,
          }
        : null,
      events: events.map((e) => ({
        type: e.type,
        payload: e.payload,
        at: e.createdAt.toISOString(),
      })),
      deliveries: legs.map((l) => ({
        id: l.id,
        viaBag: l.viaBag,
        legType: l.legType,
        provider: l.providerKey,
        status: l.status,
        courierName: l.courierName,
        createdAt: l.createdAt.toISOString(),
        endedAt: l.endedAt?.toISOString() ?? null,
      })),
    };
  }

  private rows(tail: string, params: unknown[]): Promise<RawRow[]> {
    return this.dataSource.query<RawRow[]>(
      `SELECT o.id, o."trackingCode", o.source, o.status::text AS status,
              o."merchantId", m."tradingName" AS "merchantName", s.reference,
              o."originNodeId" AS "originId", origin.name AS "originName",
              o."destinationNodeId" AS "destinationId", dest.name AS "destinationName",
              o."amountKobo", o."rerouteState", b.code AS "bagCode",
              o."createdAt", o."updatedAt"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
         LEFT JOIN merchants m ON m.id = o."merchantId"
         LEFT JOIN merchant_shipments s ON s."orderId" = o.id
         LEFT JOIN bags b ON b.id = o."bagId"
       ${tail}`,
      params,
    );
  }

  private view(row: RawRow): AdminOrderRow {
    return {
      id: row.id,
      trackingCode: row.trackingCode,
      source: row.source,
      status: row.status,
      merchant: row.merchantId
        ? { id: row.merchantId, name: row.merchantName ?? '' }
        : null,
      reference: row.reference,
      origin: { id: row.originId, name: row.originName },
      destination: { id: row.destinationId, name: row.destinationName },
      amountKobo: Number(row.amountKobo),
      rerouteState: row.rerouteState,
      bagCode: row.bagCode,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

// 08031234567 → *******4567
export function maskPhone(phone: string): string {
  return phone.length <= 4
    ? phone
    : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

// chioma@example.com → c*****@example.com
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return domain
    ? `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`
    : email;
}
