import { MigrationInterface, QueryRunner } from 'typeorm';

// M5c: the reroute queue (plan §6.5, D15) for merchant parcels whose
// destination is full or closed when they're dropped off; per-Node daily
// caps on merchant parcels addressed to a Node; and reverse bags (returns
// travelling back to a hub in bags, plan §7.2).
export class AddRerouteArrivalCapsReverseBags1786119888377 implements MigrationInterface {
  name = 'AddRerouteArrivalCapsReverseBags1786119888377';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders"
         ADD "rerouteState" character varying(10) NOT NULL DEFAULT 'none',
         ADD "rerouteReason" character varying(40),
         ADD "rerouteRequestedAt" TIMESTAMP WITH TIME ZONE,
         ADD "rerouteResolvedAt" TIMESTAMP WITH TIME ZONE,
         ADD "rerouteAuto" boolean NOT NULL DEFAULT false,
         ADD CONSTRAINT "CHK_orders_reroute_state" CHECK ("rerouteState" IN ('none', 'pending', 'resolved'))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_reroute_pending" ON "orders" ("rerouteRequestedAt")
         WHERE "rerouteState" = 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "merchantDailyArrivalCap" integer,
         ADD CONSTRAINT "CHK_nodes_merchant_arrival_cap" CHECK ("merchantDailyArrivalCap" IS NULL OR "merchantDailyArrivalCap" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "bags" ADD "direction" character varying(10) NOT NULL DEFAULT 'forward',
         ADD CONSTRAINT "CHK_bags_direction" CHECK ("direction" IN ('forward', 'return'))`,
    );
    // A hub can have a forward and a return bag open with the same Node.
    await queryRunner.query(`DROP INDEX "UQ_bags_open_route"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_bags_open_route" ON "bags" ("originNodeId", "destinationNodeId", "direction")
         WHERE "status" = 'open'`,
    );
    // Counting merchant parcels addressed to a Node per day.
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipments_destination_day" ON "merchant_shipments"
         ((destination->>'nodeId'), "createdAt") WHERE mode = 'live'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_merchant_shipments_destination_day"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_bags_open_route"`);
    await queryRunner.query(
      `ALTER TABLE "bags" DROP CONSTRAINT "CHK_bags_direction", DROP COLUMN "direction"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_bags_open_route" ON "bags" ("originNodeId", "destinationNodeId")
         WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" DROP CONSTRAINT "CHK_nodes_merchant_arrival_cap", DROP COLUMN "merchantDailyArrivalCap"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_orders_reroute_pending"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_reroute_state",
         DROP COLUMN "rerouteAuto", DROP COLUMN "rerouteResolvedAt",
         DROP COLUMN "rerouteRequestedAt", DROP COLUMN "rerouteReason",
         DROP COLUMN "rerouteState"`,
    );
  }
}
