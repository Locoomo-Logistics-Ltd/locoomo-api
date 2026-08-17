import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  MyOrderResponseDto,
  MyOrderRow,
} from '../interface/dto/my-order-response.dto';

// Raw-SQL join against `orders`/`nodes`, same cross-module read pattern as
// BrowseAvailableOrdersService — the rider's full order history, every
// status, no filtering: same "show everything, let the client decide what
// to highlight" shape as OrderQueryService.findMine for consumers. The
// `status` field on each row is what a client uses to tell "needs a
// pickup/arrival code" (rider_assigned/in_transit) apart from settled
// orders, rather than the API doing that filtering server-side.
@Injectable()
export class ListMyOrdersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(
    riderId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<MyOrderResponseDto>> {
    const offset = (query.page - 1) * query.limit;

    const rows = await this.dataSource.query<MyOrderRow[]>(
      `SELECT o.id, o."trackingCode", o.status, o."originNodeId", o."destinationNodeId",
              o."parcelDescription", o."parcelSize", o."createdAt",
              origin.name AS "originNodeName", origin.address AS "originNodeAddress",
              dest.name AS "destinationNodeName", dest.address AS "destinationNodeAddress"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o."riderId" = $1
        ORDER BY o."createdAt" DESC
        LIMIT $2 OFFSET $3`,
      [riderId, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM orders WHERE "riderId" = $1`,
      [riderId],
    );

    const items = rows.map((row) => MyOrderResponseDto.fromRow(row));
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
