import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
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

// Admin app › All orders (plan §10): consumer and merchant parcels in one
// list for ops and support, with the filters they search by. Read-only.
@Injectable()
export class AdminOrdersQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(filter: AdminOrderFilter): Promise<CursorPage<AdminOrderRow>> {
    const params: unknown[] = [filter.limit + 1];
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
