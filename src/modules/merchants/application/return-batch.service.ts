import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuditActor, AuditService } from '../../../common/audit/audit.service';
import { createSecretBox } from '../../../common/crypto/data-encryption-key';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { SecretBox } from '../../../common/crypto/secret-box';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  CursorPage,
  CursorPosition,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import type { Env } from '../../../config/env.validation';
import { ReturnCollectionService } from '../../handoffs/application/return-collection.service';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import { PublicHolidayService } from '../../orders/application/public-holiday.service';
import {
  InvalidReturnBatchCodeException,
  ReturnBatchInvalidException,
  ReturnBatchNotOpenException,
  TestModeOnlyException,
} from '../domain/exceptions/merchant.exceptions';
import {
  MAX_RETURN_BATCH_CODE_ATTEMPTS,
  newReturnBatchCode,
  newReturnBatchReference,
  normaliseReturnBatchReference,
  RETURN_BATCH_CODE_WORKING_DAYS,
  ReturnBatchProblem,
  ReturnBatchStatus,
} from '../domain/return-batch';
import { ShipmentStatus } from '../domain/shipment';
import {
  MerchantReturnBatchEntity,
  MerchantReturnBatchItemEntity,
} from '../infrastructure/entities/merchant-return-batch.entity';
import { MerchantShipmentEntity } from '../infrastructure/entities/merchant-shipment.entity';
import type { MerchantCaller } from './merchant-state';
import { ShipmentSimulatorService } from './shipment-simulator.service';

export interface ReturnNode {
  id: string;
  name: string;
  address: string;
  city: string;
}

// Public contract (MERCHANT_API.md §11.3).
export interface ReturnItemView {
  shipmentId: string;
  reference: string;
  trackingCode: string;
  status: string;
  returnReason: string | null;
  readyForCollectionAt: string | null;
  node: ReturnNode;
  returnBatch: { id: string; reference: string } | null;
}

export interface ReturnBatchShipment {
  id: string;
  reference: string;
  trackingCode: string;
  status: string;
  collectedAt: string | null;
}

export interface ReturnBatchView {
  id: string;
  reference: string;
  status: ReturnBatchStatus;
  node: ReturnNode;
  // Only while open; show it at the counter.
  code: string | null;
  codeExpiresAt: string | null;
  shipmentCount: number;
  shipments?: ReturnBatchShipment[];
  collectedAt: string | null;
  collectorName: string | null;
  createdAt: string;
}

// What Node staff see after typing the batch reference.
export interface NodeReturnBatchView {
  reference: string;
  merchantName: string;
  status: ReturnBatchStatus;
  nodeId: string;
  nodeName: string;
  codeExpiresAt: string;
  parcels: {
    trackingCode: string;
    merchantReference: string;
    shelfNumber: number | null;
    // Still on the shelf waiting for this batch; false if it was handed
    // back on its own code meanwhile.
    waiting: boolean;
  }[];
}

const S = ShipmentStatus;
const ms = cursorTime('s."statusChangedAt"');

// Merchant return batches (plan §6.3, M4f2). The merchant picks returns
// waiting at one Node and gets one code; Node staff look the batch up by
// its reference and hand every parcel back on that code. Live parcels go
// back through handoffs (ReturnCollectionService), which ends each order
// and so mirrors `shipment.returned`; test batches are collected with the
// sandbox endpoint.
@Injectable()
export class ReturnBatchService {
  private readonly box: SecretBox;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService<Env, true>,
    private readonly holidays: PublicHolidayService,
    private readonly nodeOperators: NodeOperatorQueryService,
    private readonly returnCollection: ReturnCollectionService,
    private readonly simulator: ShipmentSimulatorService,
    private readonly audit: AuditService,
  ) {
    this.box = createSecretBox(config, 'return-batch-code');
  }

  // ─── Merchant ─────────────────────────────────────────────────────────

  // `ready`: waiting at their Node (return_ready), oldest first so the
  // ones closest to storage fees come first. `incoming`: on the way back.
  async returns(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    filter: {
      state: 'ready' | 'incoming';
      nodeId?: string;
      limit: number;
      cursor?: string;
    },
  ): Promise<CursorPage<ReturnItemView>> {
    const params: unknown[] = [
      caller.merchantId,
      caller.mode,
      filter.state === 'ready' ? S.RETURN_READY : S.RETURNING,
      filter.limit + 1,
    ];
    const where = ['s."merchantId" = $1', 's.mode = $2', 's.status = $3'];
    if (filter.nodeId) {
      params.push(filter.nodeId);
      where.push(`s.origin->>'nodeId' = $${params.length}`);
    }
    const after = decodeCursor(filter.cursor);
    if (after) {
      params.push(after.t, after.id);
      where.push(
        `(${ms}, s.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows = await this.dataSource.query<
      {
        id: string;
        reference: string;
        trackingCode: string;
        status: string;
        returnInfo: {
          reason: string;
          readyForCollectionAt: string | null;
        } | null;
        statusChangedAt: Date;
        nodeId: string;
        nodeName: string;
        nodeAddress: string;
        nodeCity: string;
        batchId: string | null;
        batchReference: string | null;
      }[]
    >(
      `SELECT s.id, s.reference, s."trackingCode", s.status, s."returnInfo",
              s."statusChangedAt", n.id AS "nodeId", n.name AS "nodeName",
              n.address AS "nodeAddress", n.city AS "nodeCity",
              b.id AS "batchId", b.reference AS "batchReference"
         FROM merchant_shipments s
         JOIN nodes n ON n.id = (s.origin->>'nodeId')::uuid
         LEFT JOIN merchant_return_batch_items i ON i."shipmentId" = s.id AND i.active
         LEFT JOIN merchant_return_batches b ON b.id = i."batchId"
        WHERE ${where.join(' AND ')}
        ORDER BY ${ms} ASC, s.id ASC
        LIMIT $4`,
      params,
    );
    return toCursorPage(
      rows,
      filter.limit,
      (row): CursorPosition => ({
        t: row.statusChangedAt.toISOString(),
        id: row.id,
      }),
      (row): ReturnItemView => ({
        shipmentId: row.id,
        reference: row.reference,
        trackingCode: row.trackingCode,
        status: row.status,
        returnReason: row.returnInfo?.reason ?? null,
        readyForCollectionAt: row.returnInfo?.readyForCollectionAt ?? null,
        node: {
          id: row.nodeId,
          name: row.nodeName,
          address: row.nodeAddress,
          city: row.nodeCity,
        },
        returnBatch: row.batchId
          ? { id: row.batchId, reference: row.batchReference! }
          : null,
      }),
    );
  }

  async create(
    caller: MerchantCaller,
    input: { nodeId: string; shipmentIds: string[] },
  ): Promise<ReturnBatchView> {
    const shipmentIds = [...new Set(input.shipmentIds)];
    const expiresAt = await this.holidays.addWorkingDays(
      new Date(),
      RETURN_BATCH_CODE_WORKING_DAYS,
    );
    try {
      const id = await this.dataSource.transaction(async (manager) => {
        const shipments = await manager
          .getRepository(MerchantShipmentEntity)
          .createQueryBuilder('s')
          .setLock('pessimistic_write')
          .where(
            's.id IN (:...ids) AND s."merchantId" = :merchantId AND s.mode = :mode',
            {
              ids: shipmentIds,
              merchantId: caller.merchantId,
              mode: caller.mode,
            },
          )
          .orderBy('s.id')
          .getMany();
        const inBatch = new Set(
          (
            await manager.query<{ shipmentId: string }[]>(
              `SELECT "shipmentId" FROM merchant_return_batch_items
                WHERE active AND "shipmentId" = ANY($1)`,
              [shipmentIds],
            )
          ).map((row) => row.shipmentId),
        );
        const byId = new Map(shipments.map((s) => [s.id, s]));
        const problems: { shipmentId: string; problem: ReturnBatchProblem }[] =
          [];
        for (const shipmentId of shipmentIds) {
          const s = byId.get(shipmentId);
          const problem: ReturnBatchProblem | null = !s
            ? 'not_found'
            : s.status !== S.RETURN_READY
              ? 'not_ready'
              : s.origin.nodeId !== input.nodeId
                ? 'other_node'
                : inBatch.has(shipmentId)
                  ? 'in_batch'
                  : null;
          if (problem) {
            problems.push({ shipmentId, problem });
          }
        }
        if (problems.length > 0) {
          throw new ReturnBatchInvalidException(problems);
        }
        const code = newReturnBatchCode();
        const batch = await manager.save(
          manager.create(MerchantReturnBatchEntity, {
            merchantId: caller.merchantId,
            mode: caller.mode,
            reference: newReturnBatchReference(),
            nodeId: input.nodeId,
            status: 'open',
            codeHash: hashToken(code),
            codeSealed: this.box.seal(Buffer.from(code)),
            codeExpiresAt: expiresAt,
            createdByUserId: caller.userId,
            createdByApiKeyId: caller.keyId,
          }),
        );
        await manager.insert(
          MerchantReturnBatchItemEntity,
          shipmentIds.map((shipmentId) => ({
            batchId: batch.id,
            shipmentId,
            active: true,
          })),
        );
        await this.audit.record(
          {
            actor: this.callerActor(caller),
            action: 'merchant.return_batch_created',
            merchantId: caller.merchantId,
            target: { type: 'merchant_return_batch', id: batch.id },
            metadata: { nodeId: input.nodeId, shipments: shipmentIds.length },
            context: caller.context,
          },
          manager,
        );
        return batch.id;
      });
      return this.get(caller, id);
    } catch (error) {
      // Two batches raced for the same shipment: the index decided.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { constraint?: string }).constraint ===
          'UQ_merchant_return_batch_items_active'
      ) {
        throw new ReturnBatchInvalidException(
          shipmentIds.map((shipmentId) => ({
            shipmentId,
            problem: 'in_batch' as const,
          })),
        );
      }
      throw error;
    }
  }

  async list(
    caller: Pick<MerchantCaller, 'merchantId' | 'mode'>,
    filter: { status?: ReturnBatchStatus; limit: number; cursor?: string },
  ): Promise<CursorPage<ReturnBatchView>> {
    const qb = this.dataSource
      .getRepository(MerchantReturnBatchEntity)
      .createQueryBuilder('b')
      .where('b."merchantId" = :merchantId AND b.mode = :mode', caller)
      .orderBy(cursorTime('b."createdAt"'), 'DESC')
      .addOrderBy('b.id', 'DESC')
      .take(filter.limit + 1);
    if (filter.status) {
      qb.andWhere('b.status = :status', { status: filter.status });
    }
    const after = decodeCursor(filter.cursor);
    if (after) {
      qb.andWhere(
        `(${cursorTime('b."createdAt"')}, b.id) < (:t::timestamptz, :id::uuid)`,
        after,
      );
    }
    const rows = await qb.getMany();
    const page = rows.slice(0, filter.limit);
    const views = await this.views(this.dataSource.manager, page, false);
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
  ): Promise<ReturnBatchView> {
    const batch = await this.dataSource.manager.findOneBy(
      MerchantReturnBatchEntity,
      { id, merchantId: caller.merchantId, mode: caller.mode },
    );
    if (!batch) {
      throw new EntityNotFoundException('Return batch', id);
    }
    const views = await this.views(this.dataSource.manager, [batch], true);
    return views.get(batch.id)!;
  }

  // A fresh code (lost, expired or locked out); the old one stops working.
  async reissueCode(
    caller: MerchantCaller,
    id: string,
  ): Promise<ReturnBatchView> {
    const expiresAt = await this.holidays.addWorkingDays(
      new Date(),
      RETURN_BATCH_CODE_WORKING_DAYS,
    );
    await this.dataSource.transaction(async (manager) => {
      const batch = await this.lockOwn(manager, caller, id);
      const code = newReturnBatchCode();
      batch.codeHash = hashToken(code);
      batch.codeSealed = this.box.seal(Buffer.from(code));
      batch.codeExpiresAt = expiresAt;
      batch.failedAttempts = 0;
      await manager.save(batch);
    });
    return this.get(caller, id);
  }

  async cancel(caller: MerchantCaller, id: string): Promise<ReturnBatchView> {
    await this.dataSource.transaction(async (manager) => {
      const batch = await this.lockOwn(manager, caller, id);
      batch.status = 'cancelled';
      batch.cancelledAt = new Date();
      await manager.save(batch);
      await manager.update(
        MerchantReturnBatchItemEntity,
        { batchId: id },
        { active: false },
      );
      await this.audit.record(
        {
          actor: this.callerActor(caller),
          action: 'merchant.return_batch_cancelled',
          merchantId: caller.merchantId,
          target: { type: 'merchant_return_batch', id },
          context: caller.context,
        },
        manager,
      );
    });
    return this.get(caller, id);
  }

  // Sandbox: Node staff hand the batch over. Each waiting test shipment
  // becomes `returned` (and fires its webhook) as in live.
  async simulateCollect(
    caller: MerchantCaller,
    id: string,
  ): Promise<ReturnBatchView> {
    if (caller.mode !== 'test') {
      throw new TestModeOnlyException();
    }
    const batch = await this.get(caller, id);
    if (batch.status !== 'open') {
      throw new ReturnBatchNotOpenException(batch.status);
    }
    const collected: string[] = [];
    for (const shipment of batch.shipments ?? []) {
      if (shipment.status === (S.RETURN_READY as string)) {
        await this.simulator.simulate(caller, shipment.id, { to: S.RETURNED });
        collected.push(shipment.id);
      }
    }
    await this.dataSource.transaction((manager) =>
      this.markCollected(manager, id, collected, {
        collectedByUserId: null,
        collectorName: 'Sandbox',
      }),
    );
    return this.get(caller, id);
  }

  // ─── Node staff ───────────────────────────────────────────────────────

  async forNode(
    userId: string,
    referenceInput: string,
  ): Promise<NodeReturnBatchView> {
    const batch = await this.findForNode(userId, referenceInput);
    const parcels = await this.dataSource.query<
      {
        trackingCode: string;
        reference: string;
        shelfNumber: number | null;
        orderStatus: string | null;
      }[]
    >(
      `SELECT s."trackingCode", s.reference, o."shelfNumber", o.status AS "orderStatus"
         FROM merchant_return_batch_items i
         JOIN merchant_shipments s ON s.id = i."shipmentId"
         LEFT JOIN orders o ON o.id = s."orderId"
        WHERE i."batchId" = $1
        ORDER BY o."shelfNumber" NULLS LAST, s."trackingCode"`,
      [batch.id],
    );
    const [names] = await this.dataSource.query<
      { merchantName: string; nodeName: string }[]
    >(
      `SELECT m."tradingName" AS "merchantName", n.name AS "nodeName"
         FROM merchants m, nodes n WHERE m.id = $1 AND n.id = $2`,
      [batch.merchantId, batch.nodeId],
    );
    return {
      reference: batch.reference,
      merchantName: names.merchantName,
      status: batch.status,
      nodeId: batch.nodeId,
      nodeName: names.nodeName,
      codeExpiresAt: batch.codeExpiresAt.toISOString(),
      parcels: parcels.map((p) => ({
        trackingCode: p.trackingCode,
        merchantReference: p.reference,
        shelfNumber: p.shelfNumber,
        waiting:
          batch.status === 'open' &&
          p.orderStatus === 'ready_for_sender_collection',
      })),
    };
  }

  // Open live batches expected at the caller's Nodes, oldest first.
  async openAtMyNodes(userId: string): Promise<NodeReturnBatchView[]> {
    const nodeIds = await this.nodeOperators.getNodeIdsForUser(userId);
    if (nodeIds.length === 0) {
      return [];
    }
    const batches = await this.dataSource.query<{ reference: string }[]>(
      `SELECT reference FROM merchant_return_batches
        WHERE status = 'open' AND mode = 'live' AND "nodeId" = ANY($1)
        ORDER BY "createdAt" LIMIT 100`,
      [nodeIds],
    );
    return Promise.all(batches.map((b) => this.forNode(userId, b.reference)));
  }

  // Hands back every parcel still waiting, on the batch code. A wrong code
  // counts towards a lockout that survives the failed request.
  async collect(
    userId: string,
    referenceInput: string,
    input: {
      code: string;
      identityConfirmed: boolean;
      collectorName?: string;
    },
  ): Promise<NodeReturnBatchView> {
    const found = await this.findForNode(userId, referenceInput);
    if (found.status !== 'open') {
      throw new ReturnBatchNotOpenException(found.status);
    }
    if (
      found.codeExpiresAt <= new Date() ||
      found.failedAttempts >= MAX_RETURN_BATCH_CODE_ATTEMPTS ||
      hashToken(input.code) !== found.codeHash
    ) {
      await this.dataSource.query(
        `UPDATE merchant_return_batches SET "failedAttempts" = "failedAttempts" + 1 WHERE id = $1`,
        [found.id],
      );
      throw new InvalidReturnBatchCodeException();
    }
    await this.dataSource.transaction(async (manager) => {
      const batch = await manager
        .getRepository(MerchantReturnBatchEntity)
        .createQueryBuilder('b')
        .setLock('pessimistic_write')
        .where('b.id = :id', { id: found.id })
        .getOneOrFail();
      if (batch.status !== 'open') {
        throw new ReturnBatchNotOpenException(batch.status);
      }
      if (batch.codeHash !== found.codeHash) {
        // Reissued while staff were typing the old one.
        throw new InvalidReturnBatchCodeException();
      }
      const items = await manager.query<
        { shipmentId: string; orderId: string | null }[]
      >(
        `SELECT i."shipmentId", s."orderId"
           FROM merchant_return_batch_items i
           JOIN merchant_shipments s ON s.id = i."shipmentId"
          WHERE i."batchId" = $1
          ORDER BY s."orderId"`,
        [batch.id],
      );
      const handedBack: string[] = [];
      for (const item of items) {
        if (
          item.orderId &&
          (await this.returnCollection.handBackInBatch(manager, item.orderId, {
            identityConfirmed: input.identityConfirmed,
            returnBatchId: batch.id,
          }))
        ) {
          handedBack.push(item.shipmentId);
        }
      }
      await this.markCollected(manager, batch.id, handedBack, {
        collectedByUserId: userId,
        collectorName: input.collectorName?.trim() || null,
      });
      await this.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'merchant.return_batch_collected',
          merchantId: batch.merchantId,
          target: { type: 'merchant_return_batch', id: batch.id },
          metadata: {
            handedBack: handedBack.length,
            of: items.length,
            identityConfirmed: input.identityConfirmed,
          },
        },
        manager,
      );
    });
    return this.forNode(userId, found.reference);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async markCollected(
    manager: EntityManager,
    batchId: string,
    collectedShipmentIds: string[],
    by: { collectedByUserId: string | null; collectorName: string | null },
  ): Promise<void> {
    const now = new Date();
    await manager.update(MerchantReturnBatchEntity, batchId, {
      status: 'collected',
      collectedAt: now,
      collectedByUserId: by.collectedByUserId,
      collectorName: by.collectorName,
    });
    await manager.query(
      `UPDATE merchant_return_batch_items
          SET active = false,
              "collectedAt" = CASE WHEN "shipmentId" = ANY($2) THEN $3::timestamptz END
        WHERE "batchId" = $1`,
      [batchId, collectedShipmentIds, now],
    );
  }

  private async findForNode(
    userId: string,
    referenceInput: string,
  ): Promise<MerchantReturnBatchEntity> {
    const reference = normaliseReturnBatchReference(referenceInput);
    const batch = reference
      ? await this.dataSource.manager.findOneBy(MerchantReturnBatchEntity, {
          reference,
          mode: 'live',
        })
      : null;
    const nodeIds = batch
      ? await this.nodeOperators.getNodeIdsForUser(userId)
      : [];
    if (!batch || !nodeIds.includes(batch.nodeId)) {
      // Another Node's batch looks the same as no batch.
      throw new EntityNotFoundException('Return batch', referenceInput);
    }
    return batch;
  }

  private async lockOwn(
    manager: EntityManager,
    caller: MerchantCaller,
    id: string,
  ): Promise<MerchantReturnBatchEntity> {
    const batch = await manager
      .getRepository(MerchantReturnBatchEntity)
      .createQueryBuilder('b')
      .setLock('pessimistic_write')
      .where('b.id = :id AND b."merchantId" = :merchantId AND b.mode = :mode', {
        id,
        merchantId: caller.merchantId,
        mode: caller.mode,
      })
      .getOne();
    if (!batch) {
      throw new EntityNotFoundException('Return batch', id);
    }
    if (batch.status !== 'open') {
      throw new ReturnBatchNotOpenException(batch.status);
    }
    return batch;
  }

  private async views(
    manager: EntityManager,
    batches: MerchantReturnBatchEntity[],
    withShipments: boolean,
  ): Promise<Map<string, ReturnBatchView>> {
    const ids = batches.map((b) => b.id);
    const views = new Map<string, ReturnBatchView>();
    if (ids.length === 0) {
      return views;
    }
    const nodes = new Map(
      (
        await manager.query<ReturnNode[]>(
          `SELECT id, name, address, city FROM nodes WHERE id = ANY($1)`,
          [[...new Set(batches.map((b) => b.nodeId))]],
        )
      ).map((n) => [n.id, n]),
    );
    const items = await manager.query<
      (ReturnBatchShipment & { batchId: string; collectedAt: Date | null })[]
    >(
      `SELECT i."batchId", s.id, s.reference, s."trackingCode", s.status, i."collectedAt"
         FROM merchant_return_batch_items i
         JOIN merchant_shipments s ON s.id = i."shipmentId"
        WHERE i."batchId" = ANY($1)
        ORDER BY s."trackingCode"`,
      [ids],
    );
    for (const batch of batches) {
      const own = items.filter((i) => i.batchId === batch.id);
      const open = batch.status === 'open';
      views.set(batch.id, {
        id: batch.id,
        reference: batch.reference,
        status: batch.status,
        node: nodes.get(batch.nodeId)!,
        code: open ? this.box.open(batch.codeSealed).toString() : null,
        codeExpiresAt: open ? batch.codeExpiresAt.toISOString() : null,
        shipmentCount: own.length,
        ...(withShipments
          ? {
              shipments: own.map((i) => ({
                id: i.id,
                reference: i.reference,
                trackingCode: i.trackingCode,
                status: i.status,
                collectedAt: i.collectedAt?.toISOString() ?? null,
              })),
            }
          : {}),
        collectedAt: batch.collectedAt?.toISOString() ?? null,
        collectorName: batch.collectorName,
        createdAt: batch.createdAt.toISOString(),
      });
    }
    return views;
  }

  private callerActor(caller: MerchantCaller): AuditActor {
    return caller.via === 'api_key'
      ? { type: 'api_key', id: caller.keyId, role: null }
      : { type: 'user', id: caller.userId };
  }
}
