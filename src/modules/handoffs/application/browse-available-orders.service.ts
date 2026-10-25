import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IN_HOUSE_PROVIDER_KEY } from '../../logistics/application/in-house-provider-key';
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
// The in-house pool: received at origin, no rider yet, and not handed to
// another courier. An order with no leg at all (dropped off before
// logistics existed) is still offered.
const IN_POOL = `o.status = 'parcel_received_at_origin' AND o."riderId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM delivery_legs l
     WHERE l."orderId" = o.id
       AND l.status IN ('requested', 'assigned', 'picked_up', 'returning')
       AND l."providerKey" <> '${IN_HOUSE_PROVIDER_KEY}'
  )`;

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
        WHERE ${IN_POOL}
        ORDER BY "distanceMeters" ASC
        LIMIT $3 OFFSET $4`,
      [query.longitude, query.latitude, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM orders o WHERE ${IN_POOL}`,
    );

    const items = rows.map((row) => AvailableOrderResponseDto.fromRow(row));
    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
