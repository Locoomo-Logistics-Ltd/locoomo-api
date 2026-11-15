import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AuditActor, AuditService } from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  CursorPage,
  CursorPosition,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import { ConfirmDropOffService } from '../../handoffs/application/confirm-drop-off.service';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import type { MeasuredParcel } from '../../orders/application/orders.service';
import {
  AmbiguousParcelCodeException,
  ManifestInvalidException,
  ManifestNotEditableException,
  NotAHubException,
  ParcelNotFoundException,
  TestModeOnlyException,
} from '../domain/exceptions/merchant.exceptions';
import {
  ManifestProblem,
  ManifestStatus,
  MAX_MANIFEST_SHIPMENTS,
  newManifestReference,
  normaliseManifestReference,
} from '../domain/manifest';
import { ShipmentStatus } from '../domain/shipment';
import { DocumentRenderer } from '../infrastructure/document-renderer';
import { MerchantManifestEntity } from '../infrastructure/entities/merchant-manifest.entity';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import type { MerchantCaller } from './merchant-state';
import { ShipmentSimulatorService } from './shipment-simulator.service';
import { WebhookEmitterService } from './webhook-emitter.service';

const S = ShipmentStatus;

export interface ManifestHub {
  id: string;
  name: string;
  address: string;
  city: string;
}

// Public contract (MERCHANT_API.md §10).
export interface ManifestView {
  id: string;
  reference: string;
  status: ManifestStatus;
  hub: ManifestHub;
  expectedDropAt: string | null;
  // Shipments declared on it.
  shipmentCount: number;
  // Scanned in at the hub (declared or not).
  receivedCount: number;
  // Scanned in under it without being declared.
  unexpectedCount: number;
  // Declared but not scanned, once the hub has finished.
  missingCount: number | null;
  closedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface ManifestReceipt {
  manifestId: string;
  reference: string;
  received: number;
  missing: { shipmentId: string; reference: string }[];
  unexpected: { shipmentId: string; reference: string }[];
}

// The hub's view of a manifest.
export interface HubManifestView {
  reference: string;
  merchantName: string;
  status: ManifestStatus;
  hubNodeId: string;
  expectedDropAt: string | null;
  expected: number;
  received: number;
  parcels: {
    trackingCode: string;
    merchantReference: string;
    externalBarcode: string | null;
    received: boolean;
    expected: boolean;
  }[];
}

// What the hub screen shows after each scan.
export interface HubScanResult {
  trackingCode: string;
  merchantReference: string;
  merchantName: string;
  destination: { nodeId: string; name: string; city: string };
  // Where it goes next at the hub: the bag for its destination (M5b).
  sortInstruction: string;
  // The bag it went into; it seals itself when full (`sealed`).
  bag: { code: string; parcelCount: number; sealed: boolean } | null;
  manifest: { reference: string; expected: boolean } | null;
  // Scanned before: nothing changed.
  alreadyReceived: boolean;
}

interface ShipmentRow {
  id: string;
  merchantId: string;
  orderId: string | null;
  status: string;
  reference: string;
  trackingCode: string;
  manifestId: string | null;
}

// Manifests (plan §7.1, M5a): a merchant declares the shipments it will
// drop at its hub together; the hub checks the truck in against it and
// the merchant gets `manifest.received` (received / missing / unexpected).
// Hub check-in scans resolve our tracking code, the merchant's reference
// or the merchant's own barcode, then drop the parcel off exactly like the
// counter does (re-home, measure, charge, capacity, dispatch).
@Injectable()
export class ManifestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodeOperators: NodeOperatorQueryService,
    private readonly dropOff: ConfirmDropOffService,
    private readonly simulator: ShipmentSimulatorService,
    private readonly webhooks: WebhookEmitterService,
    private readonly renderer: DocumentRenderer,
    private readonly audit: AuditService,
  ) {}

  // ─── Merchant ─────────────────────────────────────────────────────────

  async create(
    caller: MerchantCaller,
    input: {
      hubNodeId?: string;
      expectedDropAt?: string;
      shipmentIds?: string[];
    },
  ): Promise<ManifestView> {
    const id = await this.dataSource.transaction(async (manager) => {
      const merchant = await manager.findOneByOrFail(MerchantEntity, {
        id: caller.merchantId,
      });
      const hubNodeId = input.hubNodeId ?? merchant.hubNodeId;
      if (!hubNodeId || !(await this.isActiveHub(manager, hubNodeId))) {
        throw new NotAHubException();
      }
      const manifest = await manager.save(
        manager.create(MerchantManifestEntity, {
          merchantId: caller.merchantId,
          mode: caller.mode,
          reference: newManifestReference(),
          hubNodeId,
          status: 'open',
          expectedDropAt: input.expectedDropAt
            ? new Date(input.expectedDropAt)
            : null,
          createdByUserId: caller.userId,
          createdByApiKeyId: caller.keyId,
        }),
      );
      if (input.shipmentIds?.length) {
        await this.addItems(manager, caller, manifest, input.shipmentIds);
      }
      await this.audit.record(
        {
          actor: this.callerActor(caller),
          action: 'merchant.manifest_created',
          merchantId: caller.merchantId,
          target: { type: 'merchant_manifest', id: manifest.id },
          metadata: { hubNodeId, shipments: input.shipmentIds?.length ?? 0 },
          context: caller.context,
        },
        manager,
      );
      return manifest.id;
    });
    return this.get(caller, id);
  }

  async addShipments(
    caller: MerchantCaller,
    id: string,
    shipmentIds: string[],
  ): Promise<ManifestView> {
    await this.dataSource.transaction(async (manager) => {
      const manifest = await this.lockOwn(manager, caller, id);
      if (manifest.status !== 'open') {
        throw new ManifestNotEditableException(manifest.status);
      }
      await this.addItems(manager, caller, manifest, shipmentIds);
    });
    return this.get(caller, id);
  }

  // The truck has left: nothing more can be added; the hub expects it.
  async close(caller: MerchantCaller, id: string): Promise<ManifestView> {
    await this.dataSource.transaction(async (manager) => {
      const manifest = await this.lockOwn(manager, caller, id);
      if (manifest.status !== 'open') {
        throw new ManifestNotEditableException(manifest.status);
      }
      manifest.status = 'closed';
      manifest.closedAt = new Date();
      await manager.save(manifest);
    });
    return this.get(caller, id);
  }

  // Its shipments are free to go on another manifest.
  async cancel(caller: MerchantCaller, id: string): Promise<ManifestView> {
    await this.dataSource.transaction(async (manager) => {
      const manifest = await this.lockOwn(manager, caller, id);
      if (manifest.status !== 'open' && manifest.status !== 'closed') {
        throw new ManifestNotEditableException(manifest.status);
      }
      manifest.status = 'cancelled';
      manifest.cancelledAt = new Date();
      await manager.save(manifest);
      await manager.query(
        `UPDATE merchant_shipments SET "manifestId" = NULL WHERE "manifestId" = $1`,
        [id],
      );
      await this.audit.record(
        {
          actor: this.callerActor(caller),
          action: 'merchant.manifest_cancelled',
          merchantId: caller.merchantId,
          target: { type: 'merchant_manifest', id },
          context: caller.context,
        },
        manager,
      );
    });
    return this.get(caller, id);
  }

  async list(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    filter: { status?: ManifestStatus; limit: number; cursor?: string },
  ): Promise<CursorPage<ManifestView>> {
    const ms = cursorTime('m."createdAt"');
    const qb = this.dataSource
      .getRepository(MerchantManifestEntity)
      .createQueryBuilder('m')
      .where('m."merchantId" = :merchantId AND m.mode = :mode', {
        merchantId: caller.merchantId,
        mode: caller.mode,
      })
      .orderBy(ms, 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(filter.limit + 1);
    if (filter.status) {
      qb.andWhere('m.status = :status', { status: filter.status });
    }
    const after = decodeCursor(filter.cursor);
    if (after) {
      qb.andWhere(`(${ms}, m.id) < (:t::timestamptz, :id::uuid)`, after);
    }
    const rows = await qb.getMany();
    const views = await this.views(rows.slice(0, filter.limit));
    return toCursorPage(
      rows,
      filter.limit,
      (row): CursorPosition => ({ t: row.createdAt.toISOString(), id: row.id }),
      (row) => views.get(row.id)!,
    );
  }

  async get(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<ManifestView> {
    const manifest = await this.own(caller, id);
    return (await this.views([manifest])).get(id)!;
  }

  // The PDF for the driver: reference + QR, hub, and every parcel on it.
  async document(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const manifest = await this.own(caller, id);
    const [meta] = await this.dataSource.query<
      {
        merchantName: string;
        name: string;
        address: string;
        city: string;
        state: string;
      }[]
    >(
      `SELECT m."tradingName" AS "merchantName", n.name, n.address, n.city, n.state
         FROM merchants m, nodes n WHERE m.id = $1 AND n.id = $2`,
      [manifest.merchantId, manifest.hubNodeId],
    );
    const shipments = await this.dataSource.query<
      { trackingCode: string; reference: string; destination: string }[]
    >(
      `SELECT s."trackingCode", s.reference,
              coalesce(s.destination->>'nodeName', '') AS destination
         FROM merchant_manifest_items i
         JOIN merchant_shipments s ON s.id = i."shipmentId"
        WHERE i."manifestId" = $1 AND i.expected
        ORDER BY s."createdAt", s.id`,
      [id],
    );
    const pdf = await this.renderer.manifestPdf({
      reference: manifest.reference,
      merchantName: meta.merchantName,
      mode: manifest.mode,
      hub: {
        name: meta.name,
        lines: [meta.address, `${meta.city}, ${meta.state}`],
      },
      expectedDropAt: manifest.expectedDropAt,
      shipments,
      generatedAt: new Date(),
    });
    return { pdf, filename: `${manifest.reference}.pdf` };
  }

  // Sandbox: the hub checks the manifest in. Every declared shipment still
  // waiting is received (firing its webhooks), except `missing` ones.
  async simulateReceive(
    caller: MerchantCaller,
    id: string,
    missingShipmentIds: string[] = [],
  ): Promise<ManifestReceipt> {
    if (caller.mode !== 'test') {
      throw new TestModeOnlyException();
    }
    const manifest = await this.own(caller, id);
    if (manifest.status !== 'open' && manifest.status !== 'closed') {
      throw new ManifestNotEditableException(manifest.status);
    }
    const items = await this.dataSource.query<
      { shipmentId: string; status: string }[]
    >(
      `SELECT i."shipmentId", s.status
         FROM merchant_manifest_items i
         JOIN merchant_shipments s ON s.id = i."shipmentId"
        WHERE i."manifestId" = $1 AND i.expected AND i."receivedAt" IS NULL`,
      [id],
    );
    const skip = new Set(missingShipmentIds);
    for (const item of items) {
      if (skip.has(item.shipmentId) || item.status !== (S.CREATED as string)) {
        continue;
      }
      await this.simulator.simulate(caller, item.shipmentId, {
        to: S.RECEIVED,
      });
      await this.dataSource.query(
        `UPDATE merchant_manifest_items SET "receivedAt" = now()
          WHERE "manifestId" = $1 AND "shipmentId" = $2`,
        [id, item.shipmentId],
      );
    }
    return this.dataSource.transaction((manager) =>
      this.complete(manager, id, null),
    );
  }

  // ─── Hub (Node app) ───────────────────────────────────────────────────

  // Live manifests on their way to the caller's hubs, soonest first.
  async expectedAtMyHubs(userId: string): Promise<HubManifestView[]> {
    const nodeIds = await this.nodeOperators.getNodeIdsForUser(userId);
    if (nodeIds.length === 0) {
      return [];
    }
    const rows = await this.dataSource.query<{ reference: string }[]>(
      `SELECT reference FROM merchant_manifests
        WHERE mode = 'live' AND status IN ('open', 'closed') AND "hubNodeId" = ANY($1)
        ORDER BY "expectedDropAt" NULLS LAST, "createdAt"
        LIMIT 100`,
      [nodeIds],
    );
    return Promise.all(
      rows.map((row) => this.forHub(userId, row.reference, false)),
    );
  }

  async forHub(
    userId: string,
    referenceInput: string,
    withParcels = true,
  ): Promise<HubManifestView> {
    const manifest = await this.findForHub(userId, referenceInput);
    const items = await this.dataSource.query<
      {
        trackingCode: string;
        reference: string;
        externalBarcode: string | null;
        expected: boolean;
        receivedAt: Date | null;
      }[]
    >(
      `SELECT s."trackingCode", s.reference, s."externalBarcode", i.expected, i."receivedAt"
         FROM merchant_manifest_items i
         JOIN merchant_shipments s ON s.id = i."shipmentId"
        WHERE i."manifestId" = $1
        ORDER BY i."receivedAt" NULLS FIRST, s."trackingCode"`,
      [manifest.id],
    );
    const [merchant] = await this.dataSource.query<{ tradingName: string }[]>(
      `SELECT "tradingName" FROM merchants WHERE id = $1`,
      [manifest.merchantId],
    );
    return {
      reference: manifest.reference,
      merchantName: merchant.tradingName,
      status: manifest.status,
      hubNodeId: manifest.hubNodeId,
      expectedDropAt: manifest.expectedDropAt?.toISOString() ?? null,
      expected: items.filter((i) => i.expected).length,
      received: items.filter((i) => i.receivedAt).length,
      parcels: withParcels
        ? items.map((i) => ({
            trackingCode: i.trackingCode,
            merchantReference: i.reference,
            externalBarcode: i.externalBarcode,
            received: i.receivedAt !== null,
            expected: i.expected,
          }))
        : [],
    };
  }

  // One parcel off the truck. Idempotent: scanning it again changes nothing.
  async scan(
    userId: string,
    input: {
      code: string;
      manifestReference?: string;
      nodeId?: string;
      measured?: MeasuredParcel;
    },
  ): Promise<HubScanResult> {
    const manifest = input.manifestReference
      ? await this.findForHub(userId, input.manifestReference)
      : null;
    if (
      manifest &&
      manifest.status !== 'open' &&
      manifest.status !== 'closed'
    ) {
      throw new ManifestNotEditableException(manifest.status);
    }
    const shipment = await this.resolve(input.code.trim(), manifest);
    const alreadyReceived = shipment.status !== (S.CREATED as string);
    if (!alreadyReceived) {
      await this.dropOff.confirm(shipment.orderId!, userId, {
        nodeId: manifest?.hubNodeId ?? input.nodeId,
        measured: input.measured,
      });
    }

    // Count it on the manifest it was scanned under, else on its own.
    // (Another merchant's parcel on this truck counts on its own manifest.)
    const manifestId =
      manifest && shipment.merchantId === manifest.merchantId
        ? manifest.id
        : shipment.manifestId;
    let onManifest: HubScanResult['manifest'] = null;
    if (manifestId) {
      const [item] = await this.dataSource.query<
        { expected: boolean; reference: string }[]
      >(
        `INSERT INTO merchant_manifest_items ("manifestId", "shipmentId", expected, "receivedAt")
         VALUES ($1, $2, false, now())
         ON CONFLICT ("manifestId", "shipmentId")
           DO UPDATE SET "receivedAt" = coalesce(merchant_manifest_items."receivedAt", now())
         RETURNING expected,
           (SELECT reference FROM merchant_manifests WHERE id = $1) AS reference`,
        [manifestId, shipment.id],
      );
      onManifest = { reference: item.reference, expected: item.expected };
    }

    const [after] = await this.dataSource.query<
      {
        destinationNodeId: string;
        destinationName: string;
        destinationCity: string;
        merchantName: string;
        bagCode: string | null;
        bagCount: number | null;
        bagStatus: string | null;
      }[]
    >(
      `SELECT n.id AS "destinationNodeId", n.name AS "destinationName",
              n.city AS "destinationCity", m."tradingName" AS "merchantName",
              b.code AS "bagCode", b."parcelCount" AS "bagCount", b.status AS "bagStatus"
         FROM merchant_shipments s
         JOIN nodes n ON n.id = (s.destination->>'nodeId')::uuid
         JOIN merchants m ON m.id = s."merchantId"
         LEFT JOIN orders o ON o.id = s."orderId"
         LEFT JOIN bags b ON b.id = o."bagId"
        WHERE s.id = $1`,
      [shipment.id],
    );
    return {
      trackingCode: shipment.trackingCode,
      merchantReference: shipment.reference,
      merchantName: after.merchantName,
      destination: {
        nodeId: after.destinationNodeId,
        name: after.destinationName,
        city: after.destinationCity,
      },
      sortInstruction: after.bagCode
        ? `Bag ${after.bagCode} → ${after.destinationName}, ${after.destinationCity}`
        : `To ${after.destinationName}, ${after.destinationCity}`,
      bag: after.bagCode
        ? {
            code: after.bagCode,
            parcelCount: after.bagCount ?? 0,
            sealed: after.bagStatus !== 'open',
          }
        : null,
      manifest: onManifest,
      alreadyReceived,
    };
  }

  // The hub has finished with the truck: report received / missing /
  // unexpected to the merchant (`manifest.received`).
  async completeAtHub(
    userId: string,
    referenceInput: string,
  ): Promise<ManifestReceipt> {
    const found = await this.findForHub(userId, referenceInput);
    return this.dataSource.transaction((manager) =>
      this.complete(manager, found.id, userId),
    );
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async complete(
    manager: EntityManager,
    id: string,
    userId: string | null,
  ): Promise<ManifestReceipt> {
    const manifest = await manager
      .getRepository(MerchantManifestEntity)
      .createQueryBuilder('m')
      .setLock('pessimistic_write')
      .where('m.id = :id', { id })
      .getOneOrFail();
    if (manifest.status !== 'open' && manifest.status !== 'closed') {
      throw new ManifestNotEditableException(manifest.status);
    }
    const items = await manager.query<
      {
        shipmentId: string;
        reference: string;
        expected: boolean;
        receivedAt: Date | null;
      }[]
    >(
      `SELECT i."shipmentId", s.reference, i.expected, i."receivedAt"
         FROM merchant_manifest_items i
         JOIN merchant_shipments s ON s.id = i."shipmentId"
        WHERE i."manifestId" = $1
        ORDER BY s.reference`,
      [id],
    );
    manifest.status = 'received';
    manifest.receivedAt = new Date();
    manifest.receivedByUserId = userId;
    await manager.save(manifest);
    const receipt: ManifestReceipt = {
      manifestId: id,
      reference: manifest.reference,
      received: items.filter((i) => i.receivedAt).length,
      missing: items
        .filter((i) => i.expected && !i.receivedAt)
        .map((i) => ({ shipmentId: i.shipmentId, reference: i.reference })),
      unexpected: items
        .filter((i) => !i.expected)
        .map((i) => ({ shipmentId: i.shipmentId, reference: i.reference })),
    };
    await this.webhooks.emit(manager, {
      merchantId: manifest.merchantId,
      mode: manifest.mode,
      type: 'manifest.received',
      data: { ...receipt },
    });
    await this.audit.record(
      {
        actor: userId
          ? { type: 'user', id: userId }
          : { type: 'system', id: null },
        action: 'merchant.manifest_received',
        merchantId: manifest.merchantId,
        target: { type: 'merchant_manifest', id },
        metadata: {
          received: receipt.received,
          missing: receipt.missing.length,
          unexpected: receipt.unexpected.length,
        },
      },
      manager,
    );
    return receipt;
  }

  // Our tracking code first; then the merchant's reference or barcode
  // (within the manifest's merchant when one was scanned).
  private async resolve(
    code: string,
    manifest: MerchantManifestEntity | null,
  ): Promise<ShipmentRow> {
    const select = `SELECT id, "merchantId", "orderId", status, reference, "trackingCode", "manifestId"
                      FROM merchant_shipments`;
    const [byTracking] = await this.dataSource.query<ShipmentRow[]>(
      `${select} WHERE mode = 'live' AND "trackingCode" = $1`,
      [code.toUpperCase()],
    );
    if (byTracking) {
      return byTracking;
    }
    const candidates = manifest
      ? await this.dataSource.query<ShipmentRow[]>(
          `${select}
            WHERE mode = 'live' AND "merchantId" = $2
              AND (reference = $1 OR "externalBarcode" = $1)
            ORDER BY (status = 'created') DESC
            LIMIT 3`,
          [code, manifest.merchantId],
        )
      : await this.dataSource.query<ShipmentRow[]>(
          `${select}
            WHERE mode = 'live' AND status = 'created'
              AND (reference = $1 OR "externalBarcode" = $1)
            LIMIT 3`,
          [code],
        );
    const waiting = candidates.filter(
      (c) => c.status === (S.CREATED as string),
    );
    if (waiting.length > 1) {
      throw new AmbiguousParcelCodeException();
    }
    const match = waiting[0] ?? candidates[0];
    if (!match) {
      throw new ParcelNotFoundException();
    }
    return match;
  }

  private async addItems(
    manager: EntityManager,
    caller: MerchantCaller,
    manifest: MerchantManifestEntity,
    shipmentIdsInput: string[],
  ): Promise<void> {
    const shipmentIds = [...new Set(shipmentIdsInput)];
    const shipments = await manager
      .getRepository(MerchantShipmentEntity)
      .createQueryBuilder('s')
      .setLock('pessimistic_write')
      .where(
        's.id IN (:...ids) AND s."merchantId" = :merchantId AND s.mode = :mode',
        { ids: shipmentIds, merchantId: caller.merchantId, mode: caller.mode },
      )
      .orderBy('s.id')
      .getMany();
    const busy = new Set(
      (
        await manager.query<{ id: string }[]>(
          `SELECT s.id FROM merchant_shipments s
             JOIN merchant_manifests m ON m.id = s."manifestId"
            WHERE s.id = ANY($1) AND m.status IN ('open', 'closed') AND m.id <> $2`,
          [shipmentIds, manifest.id],
        )
      ).map((row) => row.id),
    );
    const byId = new Map(shipments.map((s) => [s.id, s]));
    const problems: { shipmentId: string; problem: ManifestProblem }[] = [];
    for (const shipmentId of shipmentIds) {
      const s = byId.get(shipmentId);
      const problem: ManifestProblem | null = !s
        ? 'not_found'
        : s.status !== S.CREATED
          ? 'not_awaiting_drop_off'
          : busy.has(shipmentId)
            ? 'in_another_manifest'
            : null;
      if (problem) {
        problems.push({ shipmentId, problem });
      }
    }
    if (problems.length > 0) {
      throw new ManifestInvalidException(problems);
    }
    const [count] = await manager.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM merchant_manifest_items WHERE "manifestId" = $1 AND expected`,
      [manifest.id],
    );
    if (count.n + shipmentIds.length > MAX_MANIFEST_SHIPMENTS) {
      throw new ManifestNotEditableException(
        `full (at most ${MAX_MANIFEST_SHIPMENTS} shipments)`,
      );
    }
    await manager.query(
      `INSERT INTO merchant_manifest_items ("manifestId", "shipmentId", expected)
       SELECT $1, unnest($2::uuid[]), true
       ON CONFLICT DO NOTHING`,
      [manifest.id, shipmentIds],
    );
    await manager.query(
      `UPDATE merchant_shipments SET "manifestId" = $1 WHERE id = ANY($2)`,
      [manifest.id, shipmentIds],
    );
  }

  private async views(
    manifests: MerchantManifestEntity[],
  ): Promise<Map<string, ManifestView>> {
    const views = new Map<string, ManifestView>();
    if (manifests.length === 0) {
      return views;
    }
    const ids = manifests.map((m) => m.id);
    const counts = new Map(
      (
        await this.dataSource.query<
          {
            manifestId: string;
            expected: number;
            received: number;
            unexpected: number;
            missing: number;
          }[]
        >(
          `SELECT "manifestId",
                  count(*) FILTER (WHERE expected)::int AS expected,
                  count(*) FILTER (WHERE "receivedAt" IS NOT NULL)::int AS received,
                  count(*) FILTER (WHERE NOT expected)::int AS unexpected,
                  count(*) FILTER (WHERE expected AND "receivedAt" IS NULL)::int AS missing
             FROM merchant_manifest_items
            WHERE "manifestId" = ANY($1)
            GROUP BY "manifestId"`,
          [ids],
        )
      ).map((row) => [row.manifestId, row]),
    );
    const hubs = new Map(
      (
        await this.dataSource.query<ManifestHub[]>(
          `SELECT id, name, address, city FROM nodes WHERE id = ANY($1)`,
          [[...new Set(manifests.map((m) => m.hubNodeId))]],
        )
      ).map((hub) => [hub.id, hub]),
    );
    for (const m of manifests) {
      const c = counts.get(m.id);
      views.set(m.id, {
        id: m.id,
        reference: m.reference,
        status: m.status,
        hub: hubs.get(m.hubNodeId)!,
        expectedDropAt: m.expectedDropAt?.toISOString() ?? null,
        shipmentCount: c?.expected ?? 0,
        receivedCount: c?.received ?? 0,
        unexpectedCount: c?.unexpected ?? 0,
        missingCount: m.status === 'received' ? (c?.missing ?? 0) : null,
        closedAt: m.closedAt?.toISOString() ?? null,
        receivedAt: m.receivedAt?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
      });
    }
    return views;
  }

  private async findForHub(
    userId: string,
    referenceInput: string,
  ): Promise<MerchantManifestEntity> {
    const reference = normaliseManifestReference(referenceInput);
    const manifest = reference
      ? await this.dataSource.manager.findOneBy(MerchantManifestEntity, {
          reference,
          mode: 'live',
        })
      : null;
    const nodeIds = manifest
      ? await this.nodeOperators.getNodeIdsForUser(userId)
      : [];
    if (!manifest || !nodeIds.includes(manifest.hubNodeId)) {
      // Another hub's manifest looks the same as none.
      throw new EntityNotFoundException('Manifest', referenceInput);
    }
    return manifest;
  }

  private async own(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    id: string,
  ): Promise<MerchantManifestEntity> {
    const manifest = await this.dataSource.manager.findOneBy(
      MerchantManifestEntity,
      { id, merchantId: caller.merchantId, mode: caller.mode },
    );
    if (!manifest) {
      throw new EntityNotFoundException('Manifest', id);
    }
    return manifest;
  }

  private async lockOwn(
    manager: EntityManager,
    caller: MerchantCaller,
    id: string,
  ): Promise<MerchantManifestEntity> {
    const manifest = await manager
      .getRepository(MerchantManifestEntity)
      .createQueryBuilder('m')
      .setLock('pessimistic_write')
      .where('m.id = :id AND m."merchantId" = :merchantId AND m.mode = :mode', {
        id,
        merchantId: caller.merchantId,
        mode: caller.mode,
      })
      .getOne();
    if (!manifest) {
      throw new EntityNotFoundException('Manifest', id);
    }
    return manifest;
  }

  private async isActiveHub(
    manager: EntityManager,
    nodeId: string,
  ): Promise<boolean> {
    const [row] = await manager.query<{ id: string }[]>(
      `SELECT id FROM nodes WHERE id = $1 AND "isHub" AND status = 'active'`,
      [nodeId],
    );
    return !!row;
  }

  private callerActor(caller: MerchantCaller): AuditActor {
    return caller.via === 'api_key'
      ? { type: 'api_key', id: caller.keyId, role: null }
      : { type: 'user', id: caller.userId };
  }
}
