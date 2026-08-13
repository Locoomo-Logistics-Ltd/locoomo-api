import { MigrationInterface, QueryRunner } from 'typeorm';

// Human-friendly order reference (LCM-XXXX-XXXX, see
// orders/domain/tracking-code.ts) — separate from the `id` UUID, which
// stays the real primary key and the API's :id param. Backfill for existing
// rows only ever runs against local/pilot test data (no production traffic
// yet), so a plain random suffix is enough — new rows always go through
// OrdersService's proper generateTrackingCode()+retry path.
export class AddOrderTrackingCode1786119888331 implements MigrationInterface {
  name = 'AddOrderTrackingCode1786119888331';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "trackingCode" character varying`,
    );
    await queryRunner.query(
      `UPDATE "orders" SET "trackingCode" = 'LCM-' || upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 4)) || '-' || upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 4)) WHERE "trackingCode" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "trackingCode" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_orders_trackingCode" ON "orders" ("trackingCode")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_trackingCode"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "trackingCode"`);
  }
}
