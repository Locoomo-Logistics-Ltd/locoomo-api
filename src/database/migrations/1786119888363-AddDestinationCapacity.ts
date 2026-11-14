import { MigrationInterface, QueryRunner } from 'typeorm';

// Two-counter Node capacity (plan §5.2, E3): parcels heading to or sitting
// at a destination now count against that Node too, so "full" covers both
// sides of the counter. `currentCount` keeps its meaning (origin holds).
export class AddDestinationCapacity1786119888363 implements MigrationInterface {
  name = 'AddDestinationCapacity1786119888363';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "destinationHeldCount" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "destinationSlotHeld" boolean NOT NULL DEFAULT false`,
    );
    // Parcels already dropped off and not yet gone from the destination
    // side hold a slot there from now on.
    await queryRunner.query(
      `UPDATE "orders" SET "destinationSlotHeld" = true
        WHERE status IN ('parcel_received_at_origin', 'rider_assigned', 'in_transit',
                         'arrived_at_destination', 'ready_for_collection')
           OR (status = 'return_initiated' AND "shelfNodeId" = "destinationNodeId")`,
    );
    await queryRunner.query(
      `UPDATE "nodes" n SET "destinationHeldCount" = held.count
         FROM (SELECT "destinationNodeId" AS id, count(*)::int AS count
                 FROM "orders" WHERE "destinationSlotHeld"
                GROUP BY "destinationNodeId") held
        WHERE n.id = held.id`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "destinationSlotHeld"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" DROP COLUMN "destinationHeldCount"`,
    );
  }
}
