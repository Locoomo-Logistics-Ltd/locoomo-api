import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export interface RiderEarningsOrder {
  id: string;
  trackingCode: string;
  amountKobo: number;
  completedAt: Date;
}

export interface RiderEarningsRow {
  riderId: string;
  riderEmail: string;
  riderFirstName: string;
  riderLastName: string;
  completedOrderCount: number;
  totalAmountKobo: number;
  orders: RiderEarningsOrder[];
}

interface RiderEarningsSummaryRow {
  riderId: string;
  riderEmail: string;
  riderFirstName: string;
  riderLastName: string;
  completedOrderCount: number;
  totalAmountKobo: number;
}

// Read-only payout-readiness report — Admin's view of what's owed to which
// rider ahead of a manual payout run (decision #14/Phase 5: payout stays
// manual, no PayoutProvider/money-movement automation exists or is planned
// here; this just makes the existing Order.riderId/amountKobo data visible
// grouped by rider). "riders" doesn't own this — it's fundamentally a
// report over completed orders, so it lives where that data does, same
// reasoning PricingController lives in payments rather than a separate
// admin module.
@Injectable()
export class RiderEarningsQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<RiderEarningsRow>> {
    const offset = (query.page - 1) * query.limit;

    // Paginated over distinct riders (not over individual orders) — each
    // page row is one rider's totals, highest-earning first so the busiest
    // riders surface first for a manual payout run.
    const summaryRows = await this.dataSource.query<RiderEarningsSummaryRow[]>(
      `SELECT o."riderId", u.email AS "riderEmail", u."firstName" AS "riderFirstName",
              u."lastName" AS "riderLastName", COUNT(*)::int AS "completedOrderCount",
              SUM(o."amountKobo")::int AS "totalAmountKobo"
         FROM orders o
         JOIN users u ON u.id = o."riderId"
        WHERE o.status = 'completed'
        GROUP BY o."riderId", u.email, u."firstName", u."lastName"
        ORDER BY "totalAmountKobo" DESC
        LIMIT $1 OFFSET $2`,
      [query.limit, offset],
    );

    const [{ total }] = await this.dataSource.query<{ total: number }[]>(
      `SELECT COUNT(DISTINCT "riderId")::int AS total FROM orders WHERE status = 'completed'`,
    );

    if (summaryRows.length === 0) {
      return new PaginatedResultDto([], query.page, query.limit, total);
    }

    const riderIds = summaryRows.map((row) => row.riderId);
    const orderRows = await this.dataSource.query<
      (RiderEarningsOrder & { riderId: string })[]
    >(
      `SELECT id, "trackingCode", "riderId", "amountKobo", "updatedAt" AS "completedAt"
         FROM orders
        WHERE status = 'completed' AND "riderId" = ANY($1)
        ORDER BY "riderId", "updatedAt" DESC`,
      [riderIds],
    );

    const ordersByRider = new Map<string, RiderEarningsOrder[]>();
    for (const { riderId, ...order } of orderRows) {
      const orders = ordersByRider.get(riderId) ?? [];
      orders.push(order);
      ordersByRider.set(riderId, orders);
    }

    const items: RiderEarningsRow[] = summaryRows.map((summary) => ({
      ...summary,
      orders: ordersByRider.get(summary.riderId) ?? [],
    }));

    return new PaginatedResultDto(items, query.page, query.limit, total);
  }
}
