import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import {
  MyNodeOrderResponseDto,
  MyNodeOrderRow,
} from '../interface/dto/my-node-order-response.dto';
import {
  MyNodeOrdersQueryDto,
  NodeQueue,
} from '../interface/dto/my-node-orders-query.dto';

// Fixed SQL per queue (never built from input) — $1 is always the caller's
// Node ids. A queue is "what's waiting on this counter", so each one is
// scoped to the side of the order the caller's Node plays in it.
const QUEUE_FILTERS: Record<NodeQueue, string> = {
  // Paid, sender hasn't dropped it off yet.
  to_receive: `o."originNodeId" = ANY($1) AND o.status = 'awaiting_drop_off'`,
  // On the origin shelf, waiting for or being handed to a rider.
  to_dispatch: `o."originNodeId" = ANY($1)
                AND o.status IN ('parcel_received_at_origin', 'rider_assigned')`,
  // Heading to the caller's Node.
  incoming: `o."destinationNodeId" = ANY($1)
             AND o.status IN ('rider_assigned', 'in_transit')`,
  // At the destination counter: to shelve, or waiting for the receiver.
  to_collect: `o."destinationNodeId" = ANY($1)
               AND o.status IN ('arrived_at_destination', 'ready_for_collection')`,
};

const ALL_ORDERS_FILTER = `o."originNodeId" = ANY($1) OR o."destinationNodeId" = ANY($1)`;

// Rider's counterpart, for the other side of the counter — every order
// that's ever touched any of this operator's Nodes, either as origin or
// destination, current and past, newest first; or one work queue of it.
// `myRole`/`nextAction` tell the client what each row means for this Node.
@Injectable()
export class ListMyNodeOrdersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  async list(
    operatorUserId: string,
    query: MyNodeOrdersQueryDto,
  ): Promise<PaginatedResultDto<MyNodeOrderResponseDto>> {
    const nodeIds =
      await this.nodeOperatorQueryService.getNodeIdsForUser(operatorUserId);
    const offset = (query.page - 1) * query.limit;
    const filter = query.queue ? QUEUE_FILTERS[query.queue] : ALL_ORDERS_FILTER;

    const rows = await this.dataSource.query<MyNodeOrderRow[]>(
      `SELECT o.id, o."trackingCode", o.status, o."originNodeId", o."destinationNodeId",
              o."parcelDescription", o."parcelSize", o."createdAt",
              o."shelfNodeId", o."shelfNumber", o."receiverFullName", o."receiverPhone",
              origin.name AS "originNodeName", dest.name AS "destinationNodeName"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE ${filter}
        ORDER BY o."createdAt" DESC
        LIMIT $2 OFFSET $3`,
      [nodeIds, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM orders o WHERE ${filter}`,
      [nodeIds],
    );

    const items = rows.map((row) =>
      MyNodeOrderResponseDto.fromRow(row, nodeIds),
    );
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
