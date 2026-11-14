import { MigrationInterface, QueryRunner } from 'typeorm';

// Merchant wallet top-ups (plan §8.2, M4b): card payments and bank
// transfers into a Paystack Dedicated Virtual Account. Kept apart from
// payment_intents, whose shipment-shaped columns can't hold a top-up.
export class CreateWalletTopUps1786119888367 implements MigrationInterface {
  name = 'CreateWalletTopUps1786119888367';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "wallet_top_ups" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "method" character varying NOT NULL,
        "status" character varying NOT NULL,
        "reference" character varying(120) NOT NULL,
        "amountKobo" bigint NOT NULL,
        "feeKobo" bigint NOT NULL DEFAULT 0,
        "creditedKobo" bigint,
        "authorizationUrl" character varying(500),
        "entryId" uuid,
        "createdByUserId" uuid,
        "paidAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_top_ups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallet_top_ups_reference" UNIQUE ("reference"),
        CONSTRAINT "CHK_wallet_top_ups_mode" CHECK ("mode" IN ('test', 'live')),
        CONSTRAINT "CHK_wallet_top_ups_method" CHECK ("method" IN ('card', 'bank_transfer')),
        CONSTRAINT "CHK_wallet_top_ups_status" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'abandoned')),
        CONSTRAINT "CHK_wallet_top_ups_amount" CHECK ("amountKobo" > 0),
        CONSTRAINT "FK_wallet_top_ups_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_top_ups_merchant_created" ON "wallet_top_ups" ("merchantId", "mode", "createdAt")`,
    );
    // The sweep's work queue.
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_top_ups_pending" ON "wallet_top_ups" ("createdAt") WHERE "status" = 'pending'`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_funding_accounts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "provider" character varying NOT NULL DEFAULT 'paystack',
        "customerCode" character varying(60) NOT NULL,
        "customerId" bigint NOT NULL,
        "providerAccountId" character varying(60) NOT NULL,
        "bankName" character varying(120) NOT NULL,
        "bankSlug" character varying(60) NOT NULL,
        "accountNumber" character varying(20) NOT NULL,
        "accountName" character varying(200) NOT NULL,
        "lastSweptAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_funding_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_funding_accounts_merchant" UNIQUE ("merchantId"),
        CONSTRAINT "UQ_merchant_funding_accounts_customer" UNIQUE ("customerCode"),
        CONSTRAINT "FK_merchant_funding_accounts_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "merchant_funding_accounts"`);
    await queryRunner.query(`DROP TABLE "wallet_top_ups"`);
  }
}
