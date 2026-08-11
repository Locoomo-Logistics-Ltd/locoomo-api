import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { EntityNotFoundException } from '../../../common/exceptions';
import { OrderEntity } from '../infrastructure/entities/order.entity';

export interface OrderWithNodeNames extends OrderEntity {
  originNodeName: string;
  originNodeAddress: string;
  destinationNodeName: string;
  destinationNodeAddress: string;
}

const SELECT_WITH_NODE_NAMES = `
  SELECT o.*,
         origin.name AS "originNodeName", origin.address AS "originNodeAddress",
         dest.name AS "destinationNodeName", dest.address AS "destinationNodeAddress"
    FROM orders o
    JOIN nodes origin ON origin.id = o."originNodeId"
    JOIN nodes dest ON dest.id = o."destinationNodeId"
`;

// Ownership-scoped, same pattern as PaymentIntentQueryService — a consumer
// can only ever see their own orders.
@Injectable()
export class OrderQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getMine(consumerId: string, id: string): Promise<OrderWithNodeNames> {
    const rows = await this.dataSource.query<OrderWithNodeNames[]>(
      `${SELECT_WITH_NODE_NAMES} WHERE o.id = $1 AND o."consumerId" = $2`,
      [id, consumerId],
    );
    const order = rows[0];
    if (!order) {
      throw new EntityNotFoundException('Order', id);
    }
    return order;
  }

  async findMine(
    consumerId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<OrderWithNodeNames>> {
    const offset = (query.page - 1) * query.limit;

    const items = await this.dataSource.query<OrderWithNodeNames[]>(
      `${SELECT_WITH_NODE_NAMES}
        WHERE o."consumerId" = $1
        ORDER BY o."createdAt" DESC
        LIMIT $2 OFFSET $3`,
      [consumerId, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM orders WHERE "consumerId" = $1`,
      [consumerId],
    );

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
