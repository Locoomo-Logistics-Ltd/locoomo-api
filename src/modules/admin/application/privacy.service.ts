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
import { CloudinaryService } from '../../../common/cloudinary/cloudinary.service';
import { BusinessException } from '../../../common/exceptions';
import { toE164 } from '../../../common/phone/phone-number';
import { shouldRunBackgroundJobs } from '../../../common/process/background-jobs';
import type { Env } from '../../../config/env.validation';

const INTERVAL_NAME = 'privacy-retention';
const INTERVAL_MS = 6 * 3_600_000;
const BATCH = 500;

// Retention (plan §11.6). Days unless noted.
export const RETENTION = {
  // Receiver details and counter photos, after the parcel's final state.
  receiverDataDays: 180,
  // KYC documents and director IDs after a rejection…
  kycAfterRejectionDays: 90,
  // …or after the merchant relationship ends (closure).
  kycAfterClosureDays: 5 * 365,
  // Sandbox shipments, manifests and return batches.
  testDataDays: 90,
} as const;

// An order is finished (nothing more will happen to it) in these statuses.
const FINAL = [
  'completed',
  'return_completed',
  'cancelled',
  'refused',
  'disposed',
  'exception',
];

// Event payload keys that may carry a receiver's personal details.
const PII_KEYS = [
  'collectorName',
  'phoneLast4',
  'idLast4',
  'receiver',
  'receiverName',
  'receiverPhone',
  'receiverEmail',
];
const REDACTED_NAME = '[redacted]';

export interface RetentionRun {
  ordersRedacted: number;
  photosDeleted: number;
  merchantsKycPurged: number;
  kycFilesDeleted: number;
  testShipmentsPurged: number;
}

export interface SubjectQuery {
  phone?: string;
  email?: string;
}

export class SubjectQueryInvalidException extends BusinessException {
  readonly errorCode = 'SUBJECT_QUERY_INVALID';
  readonly httpStatus = 422;

  constructor() {
    super('Give a valid phone number or email address');
  }
}

// Privacy and NDPA (plan §11.6, M6d). Nightly-ish retention: receiver
// details and counter photos go 180 days after a parcel is finished; KYC
// files 90 days after a rejection or 5 years after closure; sandbox data
// after 90 days. Data-subject requests: export, or erase, everything held
// about a receiver by phone or email (parcels still moving are skipped
// until they finish). Audit entries never hold the personal data itself.
@Injectable()
export class PrivacyService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrivacyService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cloudinary: CloudinaryService,
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

  // ─── Retention ────────────────────────────────────────────────────────

  async run(now = new Date()): Promise<RetentionRun> {
    const day = 86_400_000;
    const orders = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM orders
        WHERE "piiRedactedAt" IS NULL AND status::text = ANY($1)
          AND "updatedAt" < $2
        ORDER BY "updatedAt" LIMIT ${BATCH}`,
      [FINAL, new Date(now.getTime() - RETENTION.receiverDataDays * day)],
    );
    const { redacted, photos } = await this.redactOrders(
      orders.map((o) => o.id),
    );
    const kyc = await this.purgeKyc(now);
    const test = await this.purgeTestData(now);
    return {
      ordersRedacted: redacted,
      photosDeleted: photos,
      merchantsKycPurged: kyc.merchants,
      kycFilesDeleted: kyc.files,
      testShipmentsPurged: test,
    };
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const result = await this.run();
      if (Object.values(result).some((n) => n > 0)) {
        this.logger.log(`Retention: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.logger.error(`Retention run failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  // Receiver details out of the order, its events, the merchant shipment
  // and its timeline; counter photos deleted from storage first (an order
  // whose photo can't be deleted now is retried next run).
  private async redactOrders(
    orderIds: string[],
  ): Promise<{ redacted: number; photos: number }> {
    if (orderIds.length === 0) {
      return { redacted: 0, photos: 0 };
    }
    const photoRows = await this.dataSource.query<
      { id: string; collection: string | null; refusal: string | null }[]
    >(
      `SELECT id, "collectionPhotoPublicId" AS collection, refusal->>'photoPublicId' AS refusal
         FROM orders WHERE id = ANY($1)`,
      [orderIds],
    );
    const ready: string[] = [];
    let photos = 0;
    for (const row of photoRows) {
      try {
        for (const publicId of [row.collection, row.refusal]) {
          if (publicId) {
            await this.cloudinary.deleteResource(publicId);
            photos += 1;
          }
        }
        ready.push(row.id);
      } catch (error) {
        this.logger.warn(
          `Order ${row.id}: counter photo not deleted yet (${String(error)})`,
        );
      }
    }
    if (ready.length > 0) {
      await this.dataSource.transaction((manager) =>
        this.redactRows(manager, ready),
      );
    }
    return { redacted: ready.length, photos };
  }

  private async redactRows(
    manager: EntityManager,
    orderIds: string[],
  ): Promise<void> {
    await manager.query(
      `UPDATE orders SET "receiverFullName" = $2, "receiverPhone" = '',
              "receiverEmail" = NULL, "collectorName" = NULL,
              "collectionPhotoPublicId" = NULL,
              refusal = CASE WHEN refusal IS NULL THEN NULL
                             ELSE jsonb_set(refusal, '{photoPublicId}', 'null') END,
              "piiRedactedAt" = now()
        WHERE id = ANY($1)`,
      [orderIds, REDACTED_NAME],
    );
    await manager.query(
      `UPDATE order_events SET payload = payload - $2::text[]
        WHERE "orderId" = ANY($1) AND payload ?| $2::text[]`,
      [orderIds, PII_KEYS],
    );
    const shipments = await manager.query<{ id: string }[]>(
      `UPDATE merchant_shipments SET "receiverName" = $2, "receiverPhone" = '',
              "receiverEmail" = NULL, "collectorName" = NULL, "piiRedactedAt" = now()
        WHERE "orderId" = ANY($1)
        RETURNING id`,
      [orderIds, REDACTED_NAME],
    );
    await this.redactShipmentEvents(
      manager,
      shipments.map((s) => s.id),
    );
  }

  private async redactShipmentEvents(
    manager: EntityManager,
    shipmentIds: string[],
  ): Promise<void> {
    if (shipmentIds.length === 0) {
      return;
    }
    await manager.query(
      `UPDATE merchant_shipment_events SET data = data - $2::text[]
        WHERE "shipmentId" = ANY($1) AND data IS NOT NULL AND data ?| $2::text[]`,
      [shipmentIds, PII_KEYS],
    );
  }

  // KYC documents and director IDs (files and rows) for merchants rejected
  // 90+ days ago or closed 5+ years ago.
  private async purgeKyc(
    now: Date,
  ): Promise<{ merchants: number; files: number }> {
    const day = 86_400_000;
    const due = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM merchants
        WHERE "kycPurgedAt" IS NULL AND (
          (status = 'rejected' AND "decidedAt" < $1) OR
          (status = 'closed' AND "closedAt" < $2))
        LIMIT 100`,
      [
        new Date(now.getTime() - RETENTION.kycAfterRejectionDays * day),
        new Date(now.getTime() - RETENTION.kycAfterClosureDays * day),
      ],
    );
    let files = 0;
    let merchants = 0;
    for (const { id } of due) {
      const assets = await this.dataSource.query<{ publicId: string }[]>(
        `SELECT "publicId" FROM merchant_documents WHERE "merchantId" = $1
         UNION ALL
         SELECT "idDocumentPublicId" FROM merchant_directors WHERE "merchantId" = $1`,
        [id],
      );
      try {
        for (const asset of assets) {
          await this.cloudinary.deleteResource(asset.publicId);
          files += 1;
        }
      } catch (error) {
        this.logger.warn(
          `Merchant ${id}: KYC files not deleted yet (${String(error)})`,
        );
        continue;
      }
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `DELETE FROM merchant_documents WHERE "merchantId" = $1`,
          [id],
        );
        await manager.query(
          `DELETE FROM merchant_directors WHERE "merchantId" = $1`,
          [id],
        );
        await manager.query(
          `UPDATE merchants SET "kycPurgedAt" = now() WHERE id = $1`,
          [id],
        );
        await this.audit.record(
          {
            actor: { type: 'system', id: null },
            action: 'merchant.kyc_purged',
            merchantId: id,
            target: { type: 'merchant', id },
            metadata: { files: assets.length },
          },
          manager,
        );
      });
      merchants += 1;
    }
    return { merchants, files };
  }

  // Sandbox data older than 90 days. Test wallet lines stay (the ledger
  // must keep summing to the balance); their shipment ids just dangle.
  private async purgeTestData(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - RETENTION.testDataDays * 86_400_000,
    );
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM merchant_manifests WHERE mode = 'test' AND "createdAt" < $1`,
        [cutoff],
      );
      await manager.query(
        `DELETE FROM merchant_return_batches WHERE mode = 'test' AND "createdAt" < $1`,
        [cutoff],
      );
      const purged = await manager.query<{ id: string }[]>(
        `DELETE FROM merchant_shipments WHERE id IN (
           SELECT id FROM merchant_shipments
            WHERE mode = 'test' AND "updatedAt" < $1 LIMIT ${BATCH})
         RETURNING id`,
        [cutoff],
      );
      return purged.length;
    });
  }

  // ─── Data-subject requests ────────────────────────────────────────────

  // Everything held about a receiver, by phone or email.
  async exportSubject(
    adminUserId: string,
    query: SubjectQuery,
    context: AuditRequestContext,
  ): Promise<{
    orders: Record<string, unknown>[];
    shipments: Record<string, unknown>[];
  }> {
    const match = this.match(query);
    const orders = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT o.id, o."trackingCode", o.status::text AS status, o.source,
              o."receiverFullName", o."receiverPhone", o."receiverEmail",
              o."collectorName", o."collectedAt", o."createdAt",
              origin.name AS origin, dest.name AS destination,
              (SELECT json_agg(json_build_object('type', e.type, 'at', e."createdAt") ORDER BY e."createdAt")
                 FROM order_events e WHERE e."orderId" = o.id) AS events
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE ${match.orders}
        ORDER BY o."createdAt"`,
      match.params,
    );
    const shipments = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT s.id, s.mode, s.reference, s."trackingCode", s.status,
              s."receiverName", s."receiverPhone", s."receiverEmail",
              s."collectorName", s."createdAt", m."tradingName" AS merchant
         FROM merchant_shipments s
         JOIN merchants m ON m.id = s."merchantId"
        WHERE ${match.shipments}
        ORDER BY s."createdAt"`,
      match.params,
    );
    await this.audit.record({
      actor: { type: 'user', id: adminUserId, role: 'admin' },
      action: 'privacy.subject_exported',
      metadata: {
        by: query.phone ? 'phone' : 'email',
        orders: orders.length,
        shipments: shipments.length,
      },
      context,
    });
    return { orders, shipments };
  }

  // Redacts a receiver's details from every finished parcel (and photos);
  // parcels still on their way are listed and left until they finish.
  async eraseSubject(
    adminUserId: string,
    query: SubjectQuery & { reason: string },
    context: AuditRequestContext,
  ): Promise<{
    erasedOrders: number;
    erasedShipments: number;
    skippedInFlight: { trackingCode: string; status: string }[];
  }> {
    const match = this.match(query);
    const orders = await this.dataSource.query<
      { id: string; trackingCode: string; status: string }[]
    >(
      `SELECT o.id, o."trackingCode", o.status::text AS status FROM orders o
        WHERE ${match.orders}`,
      match.params,
    );
    const finished = orders.filter((o) => FINAL.includes(o.status));
    const { redacted } = await this.redactOrders(finished.map((o) => o.id));
    // Sandbox shipments (no order) for the same person.
    const standalone = await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<{ id: string }[]>(
        `UPDATE merchant_shipments s SET "receiverName" = '${REDACTED_NAME}', "receiverPhone" = '',
                "receiverEmail" = NULL, "collectorName" = NULL, "piiRedactedAt" = now()
          WHERE s."orderId" IS NULL AND ${match.shipments}
          RETURNING id`,
        match.params,
      );
      await this.redactShipmentEvents(
        manager,
        rows.map((r) => r.id),
      );
      return rows.length;
    });
    const skipped = orders
      .filter((o) => !FINAL.includes(o.status))
      .map((o) => ({ trackingCode: o.trackingCode, status: o.status }));
    await this.audit.record({
      actor: { type: 'user', id: adminUserId, role: 'admin' },
      action: 'privacy.subject_erased',
      metadata: {
        by: query.phone ? 'phone' : 'email',
        reason: query.reason,
        erasedOrders: redacted,
        erasedShipments: standalone,
        skippedInFlight: skipped.length,
      },
      context,
    });
    return {
      erasedOrders: redacted,
      erasedShipments: standalone,
      skippedInFlight: skipped,
    };
  }

  private match(query: SubjectQuery): {
    orders: string;
    shipments: string;
    params: unknown[];
  } {
    if (query.phone) {
      const phone = toE164(query.phone);
      if (!phone) {
        throw new SubjectQueryInvalidException();
      }
      return {
        orders: `o."receiverPhone" = $1`,
        shipments: `s."receiverPhone" = $1`,
        params: [phone],
      };
    }
    const email = query.email?.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new SubjectQueryInvalidException();
    }
    return {
      orders: `lower(o."receiverEmail") = $1`,
      shipments: `lower(s."receiverEmail") = $1`,
      params: [email],
    };
  }
}
