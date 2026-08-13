import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import { OrderPreviewRow } from '../interface/dto/order-preview-response.dto';

// Every Node-operator-facing handoff step (drop-off today, pickup/arrival
// intake later) needs to answer "does this order actually belong to my
// Node" before touching it — not-found-not-forbidden on a mismatch, same
// pattern used everywhere else in this codebase for ownership checks.
@Injectable()
export class OrderLookupService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  async findByTrackingCodeForOrigin(
    trackingCode: string,
    operatorUserId: string,
  ): Promise<OrderPreviewRow> {
    const operatorNodeId =
      await this.nodeOperatorQueryService.getNodeIdForUser(operatorUserId);

    const rows = await this.dataSource.query<OrderPreviewRow[]>(
      `SELECT o.id, o."trackingCode", o.status, o."originNodeId",
              o."destinationNodeId", o."parcelDescription", o."parcelSize",
              o."createdAt", dest.name AS "destinationNodeName"
         FROM orders o
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o."trackingCode" = $1 AND o."originNodeId" = $2`,
      [trackingCode, operatorNodeId],
    );
    const order = rows[0];
    if (!order) {
      throw new EntityNotFoundException('Order', trackingCode);
    }
    return order;
  }

  // Ownership is immutable (originNodeId never changes once an Order is
  // created), so this doesn't need to run inside the same transaction as
  // whatever transition the caller performs afterward — a plain read is
  // enough.
  async assertOriginNodeOwnership(
    orderId: string,
    operatorUserId: string,
  ): Promise<void> {
    const operatorNodeId =
      await this.nodeOperatorQueryService.getNodeIdForUser(operatorUserId);

    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM orders WHERE id = $1 AND "originNodeId" = $2`,
      [orderId, operatorNodeId],
    );
    if (rows.length === 0) {
      throw new EntityNotFoundException('Order', orderId);
    }
  }
}
