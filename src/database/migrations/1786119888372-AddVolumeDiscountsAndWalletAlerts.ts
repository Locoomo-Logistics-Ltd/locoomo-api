import { MigrationInterface, QueryRunner } from 'typeorm';

// M4e1: volume discount tiers (plan §8.3, F1) with per-merchant overrides,
// the discount carried on orders (E7: earnings use the undiscounted fee),
// and wallet low-balance / negative-floor alerts (§8.4).
export class AddVolumeDiscountsAndWalletAlerts1786119888372 implements MigrationInterface {
  name = 'AddVolumeDiscountsAndWalletAlerts1786119888372';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "volume_discount_tier_sets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tiers" jsonb NOT NULL,
        "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdByAdminId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_volume_discount_tier_sets" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `INSERT INTO "volume_discount_tier_sets" ("tiers", "effectiveFrom")
       VALUES ('[{"minShipments":0,"percent":0},{"minShipments":500,"percent":5},{"minShipments":5000,"percent":10},{"minShipments":50000,"percent":15}]'::jsonb, '2026-01-01T00:00:00Z')`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "discountPercentOverride" numeric(5,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD CONSTRAINT "CHK_merchants_discount_override"
         CHECK ("discountPercentOverride" IS NULL OR ("discountPercentOverride" >= 0 AND "discountPercentOverride" <= 50))`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "discountKobo" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchant_wallets"
         ADD "lowBalanceThresholdKobo" bigint,
         ADD "lowBalanceAlertedAt" TIMESTAMP WITH TIME ZONE,
         ADD "floorAlertedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "merchant_wallets"
         DROP COLUMN "lowBalanceThresholdKobo",
         DROP COLUMN "lowBalanceAlertedAt",
         DROP COLUMN "floorAlertedAt"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "discountKobo"`);
    await queryRunner.query(
      `ALTER TABLE "merchants" DROP CONSTRAINT "CHK_merchants_discount_override"`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchants" DROP COLUMN "discountPercentOverride"`,
    );
    await queryRunner.query(`DROP TABLE "volume_discount_tier_sets"`);
  }
}
