import { MigrationInterface, QueryRunner } from 'typeorm';

// M4f1: claims for lost or damaged parcels (plan §6.6, D18). At most one
// open or approved claim per shipment; a rejected claim can be followed by
// a new one inside the window.
export class CreateMerchantClaims1786119888373 implements MigrationInterface {
  name = 'CreateMerchantClaims1786119888373';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchant_claims" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "shipmentId" uuid NOT NULL,
        "type" character varying(20) NOT NULL,
        "source" character varying(20) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "description" character varying(2000) NOT NULL,
        "evidence" jsonb NOT NULL DEFAULT '[]',
        "declaredValueKobo" bigint,
        "maxPayoutKobo" bigint NOT NULL,
        "payoutKobo" bigint,
        "payoutApprovalId" uuid,
        "walletEntryId" uuid,
        "merchantNote" character varying(1000),
        "internalNote" character varying(2000),
        "filedByUserId" uuid,
        "filedByApiKeyId" uuid,
        "decidedByUserId" uuid,
        "decidedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_claims" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_merchant_claims_type" CHECK ("type" IN ('lost', 'damaged', 'missing_item')),
        CONSTRAINT "CHK_merchant_claims_status" CHECK ("status" IN ('open', 'approved', 'rejected')),
        CONSTRAINT "CHK_merchant_claims_source" CHECK ("source" IN ('merchant', 'exception')),
        CONSTRAINT "FK_merchant_claims_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_claims_shipment" FOREIGN KEY ("shipmentId") REFERENCES "merchant_shipments"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_merchant_claims_active_shipment" ON "merchant_claims" ("shipmentId")
         WHERE "status" IN ('open', 'approved')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_claims_merchant" ON "merchant_claims" ("merchantId", "mode", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_claims_queue" ON "merchant_claims" ("status", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "merchant_claims"`);
  }
}
