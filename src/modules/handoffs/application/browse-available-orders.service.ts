import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import {
  AvailableOrderResponseDto,
  AvailableOrderRow,
} from '../interface/dto/available-order-response.dto';
import { AvailableOrdersQueryDto } from '../interface/dto/available-orders-query.dto';

// Raw-SQL join against `orders`/`nodes` table names directly — same
// cross-module read pattern OrderQueryService and NodeOperatorQueryService
// already use. Distance is computed against the rider-supplied lat/long on
// every request; nothing about the rider's location is stored (no feature
// needs persistent tracking yet — see conversation). The order-status
// filter is a raw literal ('parcel_received_at_origin'), not an imported
// OrderStatus enum value — same reasoning NodeOperatorQueryService already
// applies to `u.status = 'pending_review'`: a read-only report knowing
// another module's stored string value doesn't need that module's domain
// enum, only the boundary rule's forbidden cross-module import would.
@Injectable()
export class BrowseAvailableOrdersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async browse(
    query: AvailableOrdersQueryDto,
  ): Promise<PaginatedResultDto<AvailableOrderResponseDto>> {
    const offset = (query.page - 1) * query.limit;
    const origin = `ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography`;

    const rows = await this.dataSource.query<AvailableOrderRow[]>(
      `SELECT o.id, o."trackingCode", o."originNodeId", o."destinationNodeId",
              o."parcelDescription", o."parcelSize", o."createdAt",
              origin.name AS "originNodeName", origin.address AS "originNodeAddress",
              dest.name AS "destinationNodeName", dest.address AS "destinationNodeAddress",
              ST_Distance(origin.location, ${origin}) AS "distanceMeters"
         FROM orders o
         JOIN nodes origin ON origin.id = o."originNodeId"
         JOIN nodes dest ON dest.id = o."destinationNodeId"
        WHERE o.status = 'parcel_received_at_origin' AND o."riderId" IS NULL
        ORDER BY "distanceMeters" ASC
        LIMIT $3 OFFSET $4`,
      [query.longitude, query.latitude, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM orders
        WHERE status = 'parcel_received_at_origin' AND "riderId" IS NULL`,
    );

    const items = rows.map((row) => AvailableOrderResponseDto.fromRow(row));
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
