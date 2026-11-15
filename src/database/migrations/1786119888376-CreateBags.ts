import { MigrationInterface, QueryRunner } from 'typeorm';

// M5b: bags (plan §7.2, D17). A hub sorts merchant parcels into one bag per
// destination Node; a sealed bag travels as ONE courier leg, owned by the
// bag instead of an order (exactly one of orderId / bagId on a leg).
export class CreateBags1786119888376 implements MigrationInterface {
  name = 'CreateBags1786119888376';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "bags" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" character varying(20) NOT NULL,
        "originNodeId" uuid NOT NULL,
        "destinationNodeId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "parcelCount" integer NOT NULL DEFAULT 0,
        "sealedAt" TIMESTAMP WITH TIME ZONE,
        "sealedByUserId" uuid,
        "arrivedAt" TIMESTAMP WITH TIME ZONE,
        "unpackedAt" TIMESTAMP WITH TIME ZONE,
        "missingAlertedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bags" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_bags_code" UNIQUE ("code"),
        CONSTRAINT "CHK_bags_status" CHECK ("status" IN ('open', 'sealed', 'in_transit', 'arrived', 'unpacked', 'cancelled')),
        CONSTRAINT "FK_bags_origin" FOREIGN KEY ("originNodeId") REFERENCES "nodes"("id"),
        CONSTRAINT "FK_bags_destination" FOREIGN KEY ("destinationNodeId") REFERENCES "nodes"("id")
      )`,
    );
    // One open bag per hub and destination: every parcel for that Node
    // goes into it until it's sealed.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_bags_open_route" ON "bags" ("originNodeId", "destinationNodeId")
         WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bags_destination_status" ON "bags" ("destinationNodeId", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "bagId" uuid,
         ADD CONSTRAINT "FK_orders_bag" FOREIGN KEY ("bagId") REFERENCES "bags"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_bag" ON "orders" ("bagId") WHERE "bagId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery_legs" ALTER COLUMN "orderId" DROP NOT NULL,
         ADD "bagId" uuid,
         ADD CONSTRAINT "FK_delivery_legs_bag" FOREIGN KEY ("bagId") REFERENCES "bags"("id"),
         ADD CONSTRAINT "CHK_delivery_legs_owner" CHECK (("orderId" IS NULL) <> ("bagId" IS NULL))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_delivery_legs_one_active_bag" ON "delivery_legs" ("bagId")
         WHERE "bagId" IS NOT NULL AND status IN ('requested', 'assigned', 'picked_up', 'returning')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_delivery_legs_one_active_bag"`);
    await queryRunner.query(
      `DELETE FROM "delivery_legs" WHERE "bagId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery_legs" DROP CONSTRAINT "CHK_delivery_legs_owner",
         DROP CONSTRAINT "FK_delivery_legs_bag", DROP COLUMN "bagId",
         ALTER COLUMN "orderId" SET NOT NULL`,
    );
    await queryRunner.query(`DROP INDEX "IDX_orders_bag"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_bag", DROP COLUMN "bagId"`,
    );
    await queryRunner.query(`DROP TABLE "bags"`);
  }
}
