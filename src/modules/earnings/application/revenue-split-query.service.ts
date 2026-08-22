import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { PayoutStatus } from '../domain/payout-status.enum';
import { RevenueSplitPartyType } from '../domain/party-type.enum';
import { AdminRevenueSplitEntryRow } from '../interface/dto/admin-revenue-split-entry-response.dto';
import { ListRevenueSplitEntriesQueryDto } from '../interface/dto/list-revenue-split-entries-query.dto';
import { RevenueSplitEntryRow } from '../interface/dto/revenue-split-entry-response.dto';

const OWN_VIEW_COLUMNS = `
  e.id, e."orderId", o."trackingCode" AS "orderTrackingCode", e."partyType",
  e."amountKobo", e."payoutStatus", e."paidAt", e."createdAt"`;

// Raw-SQL join against `orders` (for trackingCode) — same cross-module read
// pattern used throughout handoffs (OrderLookupService, BrowseAvailableOrdersService).
@Injectable()
export class RevenueSplitQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listForRider(
    riderId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<RevenueSplitEntryRow>> {
    return this.listForParty([RevenueSplitPartyType.RIDER], riderId, query);
  }

  // A Node earns two distinct entry types depending on its role per order —
  // NODE (origin's 20% cut) and DESTINATION_NODE (destination's flat fee,
  // see RecordRevenueSplitService) — both keyed by the same Node id, so a
  // Node operator's "my own earnings" view shows both without needing two
  // separate calls.
  async listForNode(
    nodeId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<RevenueSplitEntryRow>> {
    return this.listForParty(
      [RevenueSplitPartyType.NODE, RevenueSplitPartyType.DESTINATION_NODE],
      nodeId,
      query,
    );
  }

  private async listForParty(
    partyTypes: RevenueSplitPartyType[],
    partyId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<RevenueSplitEntryRow>> {
    const offset = (query.page - 1) * query.limit;

    const items = await this.dataSource.query<RevenueSplitEntryRow[]>(
      `SELECT${OWN_VIEW_COLUMNS}
         FROM revenue_split_entries e
         JOIN orders o ON o.id = e."orderId"
        WHERE e."partyType" = ANY($1) AND e."partyId" = $2
        ORDER BY e."createdAt" DESC
        LIMIT $3 OFFSET $4`,
      [partyTypes, partyId, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM revenue_split_entries
        WHERE "partyType" = ANY($1) AND "partyId" = $2`,
      [partyTypes, partyId],
    );

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }

  // Admin's view — every entry, optional partyType/payoutStatus filters,
  // enriched with a human-readable partyLabel (see
  // AdminRevenueSplitEntryResponseDto for why).
  async listAll(
    query: ListRevenueSplitEntriesQueryDto,
  ): Promise<PaginatedResultDto<AdminRevenueSplitEntryRow>> {
    const offset = (query.page - 1) * query.limit;
    const conditions: string[] = [];
    const params: (string | PayoutStatus | RevenueSplitPartyType)[] = [];

    if (query.partyType) {
      params.push(query.partyType);
      conditions.push(`e."partyType" = $${params.length}`);
    }
    if (query.payoutStatus) {
      params.push(query.payoutStatus);
      conditions.push(`e."payoutStatus" = $${params.length}`);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const items = await this.dataSource.query<AdminRevenueSplitEntryRow[]>(
      `SELECT e.id, e."orderId", o."trackingCode" AS "orderTrackingCode",
              e."partyType", e."partyId",
              CASE e."partyType"
                WHEN 'rider' THEN u.email
                WHEN 'node' THEN n.name
                WHEN 'destination_node' THEN n.name
                ELSE 'Platform'
              END AS "partyLabel",
              e."amountKobo", e."payoutStatus", e."paidAt", e."paidByAdminId",
              paidByAdmin.email AS "paidByAdminEmail",
              e."createdAt"
         FROM revenue_split_entries e
         JOIN orders o ON o.id = e."orderId"
         LEFT JOIN users u ON e."partyType" = 'rider' AND u.id = e."partyId"
         LEFT JOIN nodes n ON e."partyType" IN ('node', 'destination_node') AND n.id = e."partyId"
         LEFT JOIN users paidByAdmin ON paidByAdmin.id = e."paidByAdminId"
         ${where}
        ORDER BY e."createdAt" DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(*)::int AS total FROM revenue_split_entries e ${where}`,
      params,
    );

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
