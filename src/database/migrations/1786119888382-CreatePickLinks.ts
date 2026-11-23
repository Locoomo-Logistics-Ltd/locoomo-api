import { MigrationInterface, QueryRunner } from 'typeorm';

// M7b: pick links (plan §2.3, §12.3). A seller shares a link; the buyer
// picks their Node and the shipment is created. Single use, 7 days.
export class CreatePickLinks1786119888382 implements MigrationInterface {
  name = 'CreatePickLinks1786119888382';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "pick_links" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "reference" character varying(64) NOT NULL,
        "tokenHash" character varying NOT NULL,
        "tokenSealed" text NOT NULL,
        "draft" jsonb NOT NULL,
        "hidePrices" boolean NOT NULL DEFAULT false,
        "status" character varying(12) NOT NULL DEFAULT 'open',
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "shipmentId" uuid,
        "usedAt" TIMESTAMP WITH TIME ZONE,
        "createdByUserId" uuid,
        "createdByApiKeyId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pick_links" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_pick_links_token" UNIQUE ("tokenHash"),
        CONSTRAINT "CHK_pick_links_status" CHECK ("status" IN ('open', 'used', 'cancelled')),
        CONSTRAINT "FK_pick_links_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_pick_links_shipment" FOREIGN KEY ("shipmentId") REFERENCES "merchant_shipments"("id") ON DELETE SET NULL
      )`,
    );
    // A reference waits on at most one open link.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_pick_links_open_reference" ON "pick_links" ("merchantId", "mode", "reference")
         WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pick_links_merchant" ON "pick_links" ("merchantId", "mode", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pick_links"`);
  }
}
