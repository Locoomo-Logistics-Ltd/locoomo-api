import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCourierLowBalanceAlert1786119888352 implements MigrationInterface {
  name = 'AddCourierLowBalanceAlert1786119888352';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Prepaid couriers: warn when the wallet's free balance (after the
    // headroom kept for in-flight surcharges) drops below this. Null = no
    // alert. Sendii placeholder: ₦50,000 — about 15–20 typical deliveries.
    await queryRunner.query(
      `ALTER TABLE "logistics_providers" ADD "lowBalanceAlertKobo" integer`,
    );
    await queryRunner.query(
      `UPDATE "logistics_providers" SET "lowBalanceAlertKobo" = 5000000 WHERE key = 'sendii'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "logistics_providers" DROP COLUMN "lowBalanceAlertKobo"`,
    );
  }
}
