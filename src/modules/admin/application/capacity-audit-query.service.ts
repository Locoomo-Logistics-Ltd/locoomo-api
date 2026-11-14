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
  // Which of the two counters (plan §5.2): origin = currentCount,
  // destination = destinationHeldCount.
  counter: 'origin' | 'destination';
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
    // RIDER_ARRIVAL, not COMPLETED).
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
    // Expected values are recomputed from order (and unpaid checkout)
    // statuses, independently of the counters and of the per-order
    // destinationSlotHeld flag, so drift in either shows up here.
    //
    // Origin: unpaid checkouts still holding their reservation, parcels
    // waiting at the origin for a courier, and returns back on its shelf.
    // Destination: from drop-off (courier dispatched towards it) until the
    // parcel is collected or leaves on a return; an uncollected parcel
    // still on the destination shelf (return_initiated) keeps its slot.
    return this.dataSource.query<NodeCapacityMismatchRow[]>(
      `WITH origin AS (
         SELECT "nodeId", SUM(held)::int AS expected FROM (
           SELECT "originNodeId" AS "nodeId", COUNT(*) AS held
             FROM payment_intents WHERE status = 'pending'
            GROUP BY "originNodeId"
           UNION ALL
           SELECT "originNodeId" AS "nodeId", COUNT(*) AS held
             FROM orders
            WHERE status IN ('awaiting_drop_off', 'parcel_received_at_origin', 'rider_assigned',
                             'returned_to_origin', 'ready_for_sender_collection')
            GROUP BY "originNodeId"
         ) parts GROUP BY "nodeId"
       ), destination AS (
         SELECT "destinationNodeId" AS "nodeId", COUNT(*)::int AS expected
           FROM orders
          WHERE status IN ('parcel_received_at_origin', 'rider_assigned', 'in_transit',
                           'arrived_at_destination', 'ready_for_collection')
             OR (status = 'return_initiated' AND "shelfNodeId" = "destinationNodeId")
          GROUP BY "destinationNodeId"
       )
       SELECT n.id AS "nodeId", n.name AS "nodeName", 'origin' AS counter,
              n."currentCount" AS "storedCount",
              COALESCE(o.expected, 0)::int AS "expectedCount"
         FROM nodes n LEFT JOIN origin o ON o."nodeId" = n.id
        WHERE n."currentCount" != COALESCE(o.expected, 0)
       UNION ALL
       SELECT n.id, n.name, 'destination',
              n."destinationHeldCount",
              COALESCE(d.expected, 0)::int
         FROM nodes n LEFT JOIN destination d ON d."nodeId" = n.id
        WHERE n."destinationHeldCount" != COALESCE(d.expected, 0)`,
    );
  }
}
