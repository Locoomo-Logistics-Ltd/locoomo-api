import { MigrationInterface, QueryRunner } from 'typeorm';

// Nullable from the start — unlike receiver/parcel details or trackingCode,
// riderId genuinely has no value until a Rider claims the order
export class AddOrderRiderId1786119888332 implements MigrationInterface {
  name = 'AddOrderRiderId1786119888332';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD "riderId" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_riderId" ON "orders" ("riderId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_riderId"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "riderId"`);
  }
}
