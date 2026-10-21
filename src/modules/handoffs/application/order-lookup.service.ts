import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { normalizeTrackingCode } from '../../orders/application/tracking-code-input';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import { OrderPreviewRow } from '../interface/dto/order-preview-response.dto';

// Every Node-operator-facing handoff step (drop-off, rider pickup/arrival,
// intake/collection) needs to answer "does this order actually belong to
// one of my Nodes" before touching it — not-found-not-forbidden on a
// mismatch, same pattern used everywhere else in this codebase for
// ownership checks.
@Injectable()
export class OrderLookupService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  // The Node app's single "scan" lookup — works at the origin *and* the
  // destination (any Node the caller is a member of), and accepts the code
  // however it was typed or scanned (see normalizeTrackingCode). Unparseable
  // input is a plain 404, same as a code that isn't theirs.
  async findByTrackingCodeForNode(
    rawCode: string,
    operatorUserId: string,
  ): Promise<{ row: OrderPreviewRow; myNodeIds: string[] }> {
    const trackingCode = normalizeTrackingCode(rawCode);
    if (!trackingCode) {
      throw new EntityNotFoundException('Order', rawCode);
    }
    const myNodeIds =
      await this.nodeOperatorQueryService.getNodeIdsForUser(operatorUserId);

    const rows = await this.dataSource.query<OrderPreviewRow[]>(
      `SELECT o.id, o."trackingCode", o.status, o."originNodeId",
              o."destinationNodeId", o."parcelDescription", o."parcelSize",
              o."createdAt", o."shelfNodeId", o."shelfNumber",
              o."receiverFullName", o."receiverPhone",
              origin.name AS "originNodeName", dest.name AS "destinationNodeName"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o."trackingCode" = $1
          AND (o."originNodeId" = ANY($2) OR o."destinationNodeId" = ANY($2))`,
      [trackingCode, myNodeIds],
    );
    const row = rows[0];
    if (!row) {
      throw new EntityNotFoundException('Order', trackingCode);
    }
    return { row, myNodeIds };
  }

  // Ownership is immutable (originNodeId never changes once an Order is
  // created), so this doesn't need to run inside the same transaction as
  // whatever transition the caller performs afterward — a plain read is
  // enough.
  async assertOriginNodeOwnership(
    orderId: string,
    operatorUserId: string,
  ): Promise<void> {
    const operatorNodeIds =
      await this.nodeOperatorQueryService.getNodeIdsForUser(operatorUserId);

    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM orders WHERE id = $1 AND "originNodeId" = ANY($2)`,
      [orderId, operatorNodeIds],
    );
    if (rows.length === 0) {
      throw new EntityNotFoundException('Order', orderId);
    }
  }

  // Mirror of assertOriginNodeOwnership for the destination-side steps
  // (rider arrival, intake, collection) — kept as a separate method rather
  // than a parameterized column name to avoid ever interpolating anything
  // into raw SQL beyond bound parameters.
  async assertDestinationNodeOwnership(
    orderId: string,
    operatorUserId: string,
  ): Promise<void> {
    const operatorNodeIds =
      await this.nodeOperatorQueryService.getNodeIdsForUser(operatorUserId);

    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM orders WHERE id = $1 AND "destinationNodeId" = ANY($2)`,
      [orderId, operatorNodeIds],
    );
    if (rows.length === 0) {
      throw new EntityNotFoundException('Order', orderId);
    }
  }
}
