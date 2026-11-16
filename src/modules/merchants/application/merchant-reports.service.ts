import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { AuditService } from '../../../common/audit/audit.service';
import { signToken, verifyToken } from '../../../common/crypto/signed-token';
import { csvRow, nairaPlain } from '../../../common/csv/csv';
import type { Env } from '../../../config/env.validation';
import type { ApiKeyMode } from '../domain/api-key';
import {
  ExportLinkInvalidException,
  ReportRangeInvalidException,
} from '../domain/exceptions/merchant.exceptions';
import type { MerchantCaller } from './merchant-state';

export type ExportType = 'shipments' | 'wallet_entries';
export const EXPORT_TYPES: readonly ExportType[] = [
  'shipments',
  'wallet_entries',
];
export const MAX_RANGE_DAYS = 93;
const LINK_MINUTES = 15;
const PAGE = 2_000;
const TOKEN_PURPOSE = 'merchant-export';

export interface ReportSummary {
  from: string;
  to: string;
  mode: ApiKeyMode;
  shipments: {
    created: number;
    byStatus: Record<string, number>;
    // Collected / (collected + sent back because nobody collected).
    collectionRate: number | null;
  };
  // Hours, medians over shipments created in the period.
  times: {
    dropOffToReadyHours: number | null;
    readyToCollectedHours: number | null;
  };
  // Kobo, wallet movements in the period.
  money: {
    shippingCharged: number;
    storageCharged: number;
    claimsCredited: number;
    toppedUp: number;
  };
  topDestinations: { nodeName: string; shipments: number }[];
}

export interface ExportLink {
  // Relative to the API host: GET it within 15 minutes (no auth header
  // needed, the token is the credential).
  downloadPath: string;
  expiresAt: string;
}

interface ExportClaims extends Record<string, unknown> {
  m: string;
  mode: ApiKeyMode;
  t: ExportType;
  f: string;
  to: string;
}

// Merchant reporting (plan §6.4, M6c): a KPI summary for a date range, and
// CSV exports of shipments or wallet lines streamed from the database
// through a 15-minute signed link (≤ 93 days per export).
@Injectable()
export class MerchantReportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  async summary(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    range: { from?: string; to?: string },
    now = new Date(),
  ): Promise<ReportSummary> {
    const { from, to } = this.range(range, now, 30);
    const params = [caller.merchantId, caller.mode, from, to];
    const byStatus = await this.dataSource.query<
      { status: string; n: number }[]
    >(
      `SELECT status, count(*)::int AS n FROM merchant_shipments
        WHERE "merchantId" = $1 AND mode = $2 AND "createdAt" >= $3 AND "createdAt" < $4
        GROUP BY status`,
      params,
    );
    const [rate] = await this.dataSource.query<
      { collected: number; uncollected: number }[]
    >(
      `SELECT count(*) FILTER (WHERE status = 'collected')::int AS collected,
              count(*) FILTER (WHERE "returnInfo"->>'reason' = 'not_collected')::int AS uncollected
         FROM merchant_shipments
        WHERE "merchantId" = $1 AND mode = $2 AND "createdAt" >= $3 AND "createdAt" < $4`,
      params,
    );
    const [times] = await this.dataSource.query<
      { dropToReady: number | null; readyToCollected: number | null }[]
    >(
      `WITH t AS (
         SELECT s.id,
                min(e."createdAt") FILTER (WHERE e.type = 'received') AS received,
                min(e."createdAt") FILTER (WHERE e.type = 'ready_for_collection') AS ready,
                min(e."createdAt") FILTER (WHERE e.type = 'collected') AS collected
           FROM merchant_shipments s
           JOIN merchant_shipment_events e ON e."shipmentId" = s.id
          WHERE s."merchantId" = $1 AND s.mode = $2 AND s."createdAt" >= $3 AND s."createdAt" < $4
          GROUP BY s.id)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ready - received) / 3600)
                FILTER (WHERE ready IS NOT NULL AND received IS NOT NULL) AS "dropToReady",
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM collected - ready) / 3600)
                FILTER (WHERE collected IS NOT NULL AND ready IS NOT NULL) AS "readyToCollected"
         FROM t`,
      params,
    );
    const [money] = await this.dataSource.query<
      { shipping: string; storage: string; claims: string; topUps: string }[]
    >(
      `SELECT coalesce(-sum("amountKobo") FILTER (WHERE type IN ('shipment_charge', 'shipment_adjustment')), 0)::text AS shipping,
              coalesce(-sum("amountKobo") FILTER (WHERE type = 'storage_fee'), 0)::text AS storage,
              coalesce(sum("amountKobo") FILTER (WHERE type = 'claim_credit'), 0)::text AS claims,
              coalesce(sum("amountKobo") FILTER (WHERE type = 'top_up'), 0)::text AS "topUps"
         FROM wallet_entries
        WHERE "merchantId" = $1 AND mode = $2 AND "createdAt" >= $3 AND "createdAt" < $4`,
      params,
    );
    const top = await this.dataSource.query<
      { nodeName: string; shipments: number }[]
    >(
      `SELECT coalesce(destination->>'nodeName', '') AS "nodeName", count(*)::int AS shipments
         FROM merchant_shipments
        WHERE "merchantId" = $1 AND mode = $2 AND "createdAt" >= $3 AND "createdAt" < $4
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`,
      params,
    );
    const round = (v: number | null): number | null =>
      v === null ? null : Math.round(Number(v) * 10) / 10;
    const finished = rate.collected + rate.uncollected;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      mode: caller.mode,
      shipments: {
        created: byStatus.reduce((sum, r) => sum + r.n, 0),
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
        collectionRate:
          finished === 0
            ? null
            : Math.round((rate.collected / finished) * 1000) / 1000,
      },
      times: {
        dropOffToReadyHours: round(times.dropToReady),
        readyToCollectedHours: round(times.readyToCollected),
      },
      money: {
        shippingCharged: Number(money.shipping),
        storageCharged: Number(money.storage),
        claimsCredited: Number(money.claims),
        toppedUp: Number(money.topUps),
      },
      topDestinations: top,
    };
  }

  async createExport(
    caller: MerchantCaller,
    input: { type: ExportType; from: string; to: string },
    now = new Date(),
  ): Promise<ExportLink> {
    const { from, to } = this.range(input, now);
    const expiresAt = new Date(now.getTime() + LINK_MINUTES * 60_000);
    const token = signToken(
      this.secret(),
      TOKEN_PURPOSE,
      {
        m: caller.merchantId,
        mode: caller.mode,
        t: input.type,
        f: from.toISOString(),
        to: to.toISOString(),
      },
      expiresAt,
    );
    await this.audit.record({
      actor:
        caller.via === 'api_key'
          ? { type: 'api_key', id: caller.keyId, role: null }
          : { type: 'user', id: caller.userId },
      action: 'merchant.export_created',
      merchantId: caller.merchantId,
      target: { type: 'merchant', id: caller.merchantId },
      metadata: { type: input.type, mode: caller.mode, from, to },
      context: caller.context,
    });
    return {
      downloadPath: `/api/v1/merchant/exports/download?token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // Streams the CSV in pages; the token is the only credential.
  async streamExport(token: string, res: Response): Promise<void> {
    const claims = verifyToken<ExportClaims>(
      this.secret(),
      TOKEN_PURPOSE,
      token,
    );
    if (!claims || !EXPORT_TYPES.includes(claims.t)) {
      throw new ExportLinkInvalidException();
    }
    const day = (iso: string): string => iso.slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="locoomo-${claims.t.replace('_', '-')}-${claims.mode}-${day(claims.f)}-to-${day(claims.to)}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    const params = [claims.m, claims.mode, claims.f, claims.to];
    if (claims.t === 'shipments') {
      res.write(
        csvRow([
          'created_at',
          'reference',
          'tracking_code',
          'status',
          'status_changed_at',
          'origin_node',
          'destination_node',
          'receiver_name',
          'parcel_size',
          'declared_value_ngn',
          'quoted_ngn',
          'charged_ngn',
          'return_reason',
        ]),
      );
      await this.pages(
        `SELECT s.id, s."createdAt", s.reference, s."trackingCode", s.status, s."statusChangedAt",
                s.origin->>'nodeName' AS origin, s.destination->>'nodeName' AS destination,
                s."receiverName", s.parcel->>'size' AS size,
                (s.parcel->>'declaredValueKobo')::bigint AS declared,
                s."quotedKobo", s."chargedKobo", s."returnInfo"->>'reason' AS "returnReason"
           FROM merchant_shipments s
          WHERE s."merchantId" = $1 AND s.mode = $2 AND s."createdAt" >= $3 AND s."createdAt" < $4`,
        's',
        params,
        (r) =>
          csvRow([
            iso(r.createdAt),
            str(r.reference),
            str(r.trackingCode),
            str(r.status),
            iso(r.statusChangedAt),
            str(r.origin),
            str(r.destination),
            str(r.receiverName),
            str(r.size),
            money(r.declared),
            money(r.quotedKobo),
            money(r.chargedKobo),
            str(r.returnReason),
          ]),
        res,
      );
    } else {
      res.write(
        csvRow([
          'created_at',
          'type',
          'description',
          'amount_ngn',
          'balance_after_ngn',
          'reference',
          'tracking_code',
        ]),
      );
      await this.pages(
        `SELECT e.id, e."createdAt", e.type, e.description, e."amountKobo", e."balanceAfterKobo",
                s.reference, s."trackingCode"
           FROM wallet_entries e
           LEFT JOIN merchant_shipments s ON s.id = e."shipmentId"
          WHERE e."merchantId" = $1 AND e.mode = $2 AND e."createdAt" >= $3 AND e."createdAt" < $4`,
        'e',
        params,
        (r) =>
          csvRow([
            iso(r.createdAt),
            str(r.type),
            str(r.description),
            money(r.amountKobo),
            money(r.balanceAfterKobo),
            str(r.reference),
            str(r.trackingCode),
          ]),
        res,
      );
    }
    res.end();
  }

  // Keyset pages by (createdAt, id) so memory stays flat at any size.
  private async pages(
    select: string,
    alias: string,
    params: unknown[],
    line: (row: Record<string, unknown>) => string,
    res: Response,
  ): Promise<void> {
    let after: { t: Date; id: string } | null = null;
    for (;;) {
      const page: Record<string, unknown>[] = await this.dataSource.query(
        `${select}
           ${after ? `AND (${alias}."createdAt", ${alias}.id) > ($5::timestamptz, $6::uuid)` : ''}
          ORDER BY ${alias}."createdAt", ${alias}.id
          LIMIT ${PAGE}`,
        after ? [...params, after.t, after.id] : params,
      );
      for (const row of page) {
        res.write(line(row));
      }
      if (page.length < PAGE) {
        return;
      }
      const last = page[page.length - 1];
      after = { t: last.createdAt as Date, id: last.id as string };
    }
  }

  // [from, to): defaults to the last `defaultDays` days; at most 93.
  private range(
    input: { from?: string; to?: string },
    now: Date,
    defaultDays?: number,
  ): { from: Date; to: Date } {
    const to = input.to ? new Date(input.to) : now;
    const from = input.from
      ? new Date(input.from)
      : defaultDays
        ? new Date(to.getTime() - defaultDays * 86_400_000)
        : null;
    if (
      !from ||
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from >= to ||
      to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000
    ) {
      throw new ReportRangeInvalidException(MAX_RANGE_DAYS);
    }
    return { from, to };
  }

  private secret(): string {
    return this.config.get('JWT_ACCESS_SECRET', { infer: true });
  }
}

// DB cells are strings, numbers, booleans, Dates or null.
const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : '';
const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : text(v);
const str = text;
const money = (v: unknown): string =>
  v === null || v === undefined || text(v) === '' ? '' : nairaPlain(Number(v));
