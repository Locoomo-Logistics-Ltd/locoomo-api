import { MigrationInterface, QueryRunner } from 'typeorm';

// M6d: data retention (plan §11.6). Markers for what the nightly jobs (and
// data-subject erasures) have already cleaned, so each runs once.
export class AddPrivacyRetention1786119888381 implements MigrationInterface {
  name = 'AddPrivacyRetention1786119888381';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "piiRedactedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchant_shipments" ADD "piiRedactedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "kycPurgedAt" TIMESTAMP WITH TIME ZONE`,
    );
    // Finished orders still holding receiver details, oldest first.
    await queryRunner.query(
      // No status in the predicate: 'disposed' is added by migration 378,
      // and a new enum value can't be used in the transaction that added it.
      `CREATE INDEX "IDX_orders_pii_retention" ON "orders" ("updatedAt")
         WHERE "piiRedactedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_orders_pii_retention"`);
    await queryRunner.query(
      `ALTER TABLE "merchants" DROP COLUMN "kycPurgedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchant_shipments" DROP COLUMN "piiRedactedAt"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "piiRedactedAt"`);
  }
}
