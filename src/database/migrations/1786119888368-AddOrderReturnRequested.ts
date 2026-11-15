import { MigrationInterface, QueryRunner } from 'typeorm';

// Merchant intercept (plan §6.3, M4c): a parcel the merchant wants back
// while it's on its way is flagged and turned round at the destination.
export class AddOrderReturnRequested1786119888368 implements MigrationInterface {
  name = 'AddOrderReturnRequested1786119888368';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "returnRequestedAt" TIMESTAMP WITH TIME ZONE`,
    );
    // merchant_shipments.orderId already exists (M2c); index it now that
    // live shipments look themselves up by order on every status change.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_merchant_shipments_order" ON "merchant_shipments" ("orderId") WHERE "orderId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_merchant_shipments_order"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "returnRequestedAt"`,
    );
  }
}
