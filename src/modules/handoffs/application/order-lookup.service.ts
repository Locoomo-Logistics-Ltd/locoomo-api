import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { normalizeTrackingCode } from '../../orders/application/tracking-code-input';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import { OrderPreviewRow } from '../interface/dto/order-preview-response.dto';
import {
  DropOffAtDestinationException,
  PrivateNodeDropOffException,
  DropOffNodeRequiredException,
} from '../domain/exceptions/counter.exceptions';

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

    // A merchant parcel not yet dropped off can be brought to any Node
    // (plan E4); the drop-off rebinds its origin to the scanning Node.
    const rows = await this.dataSource.query<OrderPreviewRow[]>(
      `SELECT o.id, o."trackingCode", o.status, o.source, o."originNodeId",
              o."destinationNodeId", o."parcelDescription", o."parcelSize",
              o."createdAt", o."shelfNodeId", o."shelfNumber",
              o."receiverFullName", o."receiverPhone", o."weightKg",
              o."lengthCm", o."widthCm", o."heightCm", o.handling, o."vehicleClass",
              origin.name AS "originNodeName", dest.name AS "destinationNodeName"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o."trackingCode" = $1
          AND (o."originNodeId" = ANY($2) OR o."destinationNodeId" = ANY($2)
               OR (o.source = 'merchant' AND o.status = 'awaiting_drop_off'
                   AND cardinality($2::uuid[]) > 0))`,
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

  // Where a parcel is being dropped off (or refused): the declared origin
  // when that's one of the caller's Nodes; otherwise, for a merchant
  // parcel not yet dropped off, the caller's Node (rebind, plan E4) —
  // `requestedNodeId` picks one when they work at several. Consumer
  // parcels must go to their declared origin (their slot was reserved
  // there at checkout). 404 when it isn't theirs to receive.
  async resolveDropOffNode(
    orderId: string,
    operatorUserId: string,
    requestedNodeId?: string,
  ): Promise<{ nodeId: string; rebind: boolean }> {
    const myNodeIds =
      await this.nodeOperatorQueryService.getNodeIdsForUser(operatorUserId);
    const [order] = await this.dataSource.query<
      {
        source: string;
        status: string;
        originNodeId: string;
        destinationNodeId: string;
      }[]
    >(
      `SELECT source, status, "originNodeId", "destinationNodeId"
         FROM orders WHERE id = $1`,
      [orderId],
    );
    if (!order || myNodeIds.length === 0) {
      throw new EntityNotFoundException('Order', orderId);
    }
    const declaredHere = myNodeIds.includes(order.originNodeId);
    const target =
      requestedNodeId ??
      (declaredHere
        ? order.originNodeId
        : myNodeIds.length === 1
          ? myNodeIds[0]
          : null);
    if (target === order.originNodeId && declaredHere) {
      return { nodeId: target, rebind: false };
    }
    if (order.source !== 'merchant' || order.status !== 'awaiting_drop_off') {
      throw new EntityNotFoundException('Order', orderId);
    }
    if (!target) {
      throw new DropOffNodeRequiredException();
    }
    if (!myNodeIds.includes(target)) {
      throw new EntityNotFoundException('Node', target);
    }
    if (target === order.destinationNodeId) {
      throw new DropOffAtDestinationException();
    }
    const [node] = await this.dataSource.query<
      { status: string; isPubliclyVisible: boolean }[]
    >(`SELECT status, "isPubliclyVisible" FROM nodes WHERE id = $1`, [target]);
    if (node?.status !== 'active') {
      throw new EntityNotFoundException('Node', target);
    }
    // A private Node takes only its owner's own parcels, never another
    // sender's (merchant parcels can't start at one).
    if (!node.isPubliclyVisible) {
      throw new PrivateNodeDropOffException();
    }
    return { nodeId: target, rebind: true };
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
