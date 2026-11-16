import { MigrationInterface, QueryRunner } from 'typeorm';

// M6a: storage fees and disposal for returns nobody collects (plan D20,
// F4). Tracked per shipment so the daily sweep is idempotent.
export class AddReturnStorage1786119888379 implements MigrationInterface {
  name = 'AddReturnStorage1786119888379';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "merchant_shipments"
         ADD "storageFeesFrom" TIMESTAMP WITH TIME ZONE,
         ADD "storageChargedThrough" date,
         ADD "disposeAt" TIMESTAMP WITH TIME ZONE,
         ADD "storageNoticeSentAt" TIMESTAMP WITH TIME ZONE,
         ADD "disposalNoticeSentAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipments_return_ready" ON "merchant_shipments" ("storageFeesFrom")
         WHERE status = 'return_ready'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_merchant_shipments_return_ready"`);
    await queryRunner.query(
      `ALTER TABLE "merchant_shipments"
         DROP COLUMN "disposalNoticeSentAt", DROP COLUMN "storageNoticeSentAt",
         DROP COLUMN "disposeAt", DROP COLUMN "storageChargedThrough",
         DROP COLUMN "storageFeesFrom"`,
    );
  }
}
