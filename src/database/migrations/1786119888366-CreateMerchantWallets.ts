import { MigrationInterface, QueryRunner } from 'typeorm';

// Merchant wallets: ledger, holds (plan §8.1, M4a). Test wallets already in
// use (shipments awaiting drop-off) are created funded with ₦1,000,000 and
// their open holds carried over, so the sandbox keeps behaving the same.
export class CreateMerchantWallets1786119888366 implements MigrationInterface {
  name = 'CreateMerchantWallets1786119888366';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchant_wallets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "balanceKobo" bigint NOT NULL DEFAULT 0,
        "heldKobo" bigint NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_wallets" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_wallets_merchant_mode" UNIQUE ("merchantId", "mode"),
        CONSTRAINT "CHK_merchant_wallets_mode" CHECK ("mode" IN ('test', 'live')),
        CONSTRAINT "CHK_merchant_wallets_held" CHECK ("heldKobo" >= 0),
        CONSTRAINT "FK_merchant_wallets_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );

    await queryRunner.query(
      `CREATE TABLE "wallet_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "walletId" uuid NOT NULL,
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "type" character varying(40) NOT NULL,
        "amountKobo" bigint NOT NULL,
        "balanceAfterKobo" bigint NOT NULL,
        "description" character varying(300) NOT NULL,
        "shipmentId" uuid,
        "holdId" uuid,
        "approvalId" uuid,
        "createdByUserId" uuid,
        "externalRef" character varying(120),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_entries" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_wallet_entries_amount" CHECK ("amountKobo" <> 0),
        CONSTRAINT "FK_wallet_entries_wallet" FOREIGN KEY ("walletId") REFERENCES "merchant_wallets"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_entries_wallet_created" ON "wallet_entries" ("walletId", "createdAt", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_entries_shipment" ON "wallet_entries" ("shipmentId") WHERE "shipmentId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_wallet_entries_external_ref" ON "wallet_entries" ("externalRef") WHERE "externalRef" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "wallet_holds" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "walletId" uuid NOT NULL,
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "shipmentId" uuid NOT NULL,
        "status" character varying NOT NULL,
        "amountKobo" bigint NOT NULL,
        "capturedKobo" bigint,
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_holds" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallet_holds_shipment" UNIQUE ("shipmentId"),
        CONSTRAINT "CHK_wallet_holds_status" CHECK ("status" IN ('active', 'captured', 'released')),
        CONSTRAINT "CHK_wallet_holds_amount" CHECK ("amountKobo" >= 0),
        CONSTRAINT "FK_wallet_holds_wallet" FOREIGN KEY ("walletId") REFERENCES "merchant_wallets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_wallet_holds_shipment" FOREIGN KEY ("shipmentId") REFERENCES "merchant_shipments"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_holds_wallet_status" ON "wallet_holds" ("walletId", "status", "createdAt")`,
    );

    // Carry the sandbox over: a funded test wallet for every merchant that
    // has test shipments, with the open (awaiting drop-off) ones held.
    await queryRunner.query(
      `INSERT INTO "merchant_wallets" ("merchantId", "mode", "balanceKobo", "heldKobo")
       SELECT s."merchantId", 'test', 100000000,
              COALESCE(SUM(s."quotedKobo") FILTER (WHERE s."feeState" = 'held'), 0)
         FROM "merchant_shipments" s
        WHERE s.mode = 'test'
        GROUP BY s."merchantId"`,
    );
    await queryRunner.query(
      `INSERT INTO "wallet_entries"
         ("walletId", "merchantId", "mode", "type", "amountKobo", "balanceAfterKobo", "description")
       SELECT w.id, w."merchantId", 'test', 'test_funding', 100000000, 100000000,
              'Test wallet funding'
         FROM "merchant_wallets" w`,
    );
    await queryRunner.query(
      `INSERT INTO "wallet_holds"
         ("walletId", "merchantId", "mode", "shipmentId", "status", "amountKobo")
       SELECT w.id, s."merchantId", 'test', s.id, 'active', s."quotedKobo"
         FROM "merchant_shipments" s
         JOIN "merchant_wallets" w ON w."merchantId" = s."merchantId" AND w.mode = 'test'
        WHERE s.mode = 'test' AND s."feeState" = 'held'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "wallet_holds"`);
    await queryRunner.query(`DROP TABLE "wallet_entries"`);
    await queryRunner.query(`DROP TABLE "merchant_wallets"`);
  }
}
