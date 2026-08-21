import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface RiderCapacityMismatchRow {
  riderId: string;
  riderEmail: string;
  storedCount: number;
  expectedCount: number;
}

export interface NodeCapacityMismatchRow {
  nodeId: string;
  nodeName: string;
  storedCount: number;
  expectedCount: number;
}

export interface CapacityAuditResult {
  riders: RiderCapacityMismatchRow[];
  nodes: NodeCapacityMismatchRow[];
}

@Injectable()
export class CapacityAuditQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async audit(): Promise<CapacityAuditResult> {
    const [riders, nodes] = await Promise.all([
      this.auditRiders(),
      this.auditNodes(),
    ]);
    return { riders, nodes };
  }

  private async auditRiders(): Promise<RiderCapacityMismatchRow[]> {
    // Expected: orders currently assigned to this rider that they haven't
    // yet handed off — the exact set RiderCapacityService.reserveDeliverySlot/
    // releaseDeliverySlot is meant to track (decision: released on
    // RIDER_ARRIVAL, not COMPLETED — see ConfirmHandoffService).
    return this.dataSource.query<RiderCapacityMismatchRow[]>(
      `SELECT rp."userId" AS "riderId", u.email AS "riderEmail",
              rp."currentActiveOrderCount" AS "storedCount",
              COALESCE(oc."expectedCount", 0)::int AS "expectedCount"
         FROM rider_profiles rp
         JOIN users u ON u.id = rp."userId"
         LEFT JOIN (
           SELECT "riderId", COUNT(*) AS "expectedCount"
             FROM orders
            WHERE status IN ('rider_assigned', 'in_transit')
            GROUP BY "riderId"
         ) oc ON oc."riderId" = rp."userId"
        WHERE rp."currentActiveOrderCount" != COALESCE(oc."expectedCount", 0)`,
    );
  }

  private async auditNodes(): Promise<NodeCapacityMismatchRow[]> {
    // Expected: PaymentIntents currently holding an origin-capacity slot —
    // still PENDING (not yet paid, not yet expired), or PAID with an Order
    // that hasn't reached IN_TRANSIT yet (rider pickup is what releases the
    // slot — see ConfirmHandoffService's RIDER_PICKUP branch). EXPIRED/FAILED
    // intents and orders already IN_TRANSIT or later never hold a slot.
    return this.dataSource.query<NodeCapacityMismatchRow[]>(
      `WITH held AS (
         SELECT "originNodeId" AS "nodeId", COUNT(*) AS held
           FROM payment_intents
          WHERE status = 'pending'
          GROUP BY "originNodeId"
         UNION ALL
         SELECT pi."originNodeId" AS "nodeId", COUNT(*) AS held
           FROM payment_intents pi
           JOIN orders o ON o."paymentIntentId" = pi.id
          WHERE pi.status = 'paid'
            AND o.status IN ('awaiting_drop_off', 'parcel_received_at_origin', 'rider_assigned')
          GROUP BY pi."originNodeId"
       ), expected AS (
         SELECT "nodeId", SUM(held)::int AS "expectedCount" FROM held GROUP BY "nodeId"
       )
       SELECT n.id AS "nodeId", n.name AS "nodeName",
              n."currentCount" AS "storedCount",
              COALESCE(e."expectedCount", 0)::int AS "expectedCount"
         FROM nodes n
         LEFT JOIN expected e ON e."nodeId" = n.id
        WHERE n."currentCount" != COALESCE(e."expectedCount", 0)`,
    );
  }
}
