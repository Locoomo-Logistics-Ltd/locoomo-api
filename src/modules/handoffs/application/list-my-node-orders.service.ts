import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { NodeOperatorQueryService } from '../../node-operators/application/node-operator-query.service';
import {
  MyNodeOrderResponseDto,
  MyNodeOrderRow,
} from '../interface/dto/my-node-order-response.dto';

// Rider's counterpart, for the other side of the counter — every order
// that's ever touched any of this operator's Nodes, either as origin or
// destination, current and past, newest first. Same "show everything,
// `status`/`myRole` tell the client what it's looking at" shape as
// ListMyOrdersService, rather than a narrower active-only queue.
@Injectable()
export class ListMyNodeOrdersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly nodeOperatorQueryService: NodeOperatorQueryService,
  ) {}

  async list(
    operatorUserId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<MyNodeOrderResponseDto>> {
    const nodeIds =
      await this.nodeOperatorQueryService.getNodeIdsForUser(operatorUserId);
    const offset = (query.page - 1) * query.limit;

    const rows = await this.dataSource.query<MyNodeOrderRow[]>(
      `SELECT o.id, o."trackingCode", o.status, o."originNodeId", o."destinationNodeId",
              o."parcelDescription", o."parcelSize", o."createdAt",
              origin.name AS "originNodeName", dest.name AS "destinationNodeName",
              CASE WHEN o."originNodeId" = ANY($1) THEN 'origin' ELSE 'destination' END AS "myRole"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o."originNodeId" = ANY($1) OR o."destinationNodeId" = ANY($1)
        ORDER BY o."createdAt" DESC
        LIMIT $2 OFFSET $3`,
      [nodeIds, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM orders
        WHERE "originNodeId" = ANY($1) OR "destinationNodeId" = ANY($1)`,
      [nodeIds],
    );

    const items = rows.map((row) => MyNodeOrderResponseDto.fromRow(row));
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
