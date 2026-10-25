import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderShelfLocation1786119888347 implements MigrationInterface {
  name = 'AddOrderShelfLocation1786119888347';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Where the parcel physically sits right now: a Node and a short number
    // staff write on the parcel. One location per order, not separate
    // origin/destination numbers — a Node is the origin for some parcels and
    // the destination for others, but it has one shelf, so numbers must be
    // unique per Node across both.
    await queryRunner.query(`ALTER TABLE "orders" ADD "shelfNodeId" uuid`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "shelfNumber" integer`);
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_shelf_pair"
         CHECK (("shelfNodeId" IS NULL) = ("shelfNumber" IS NULL))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_orders_shelf_slot" ON "orders" ("shelfNodeId", "shelfNumber")
         WHERE "shelfNodeId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_shelf_slot"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_shelf_pair"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "shelfNumber"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "shelfNodeId"`);
  }
}
