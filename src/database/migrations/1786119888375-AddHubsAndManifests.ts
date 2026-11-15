import { MigrationInterface, QueryRunner } from 'typeorm';

// M5a: hubs (plan §7, D2, D17) and manifests. A hub is a Node flagged by
// an admin; each merchant may be assigned one as its default origin. A
// manifest declares the shipments a merchant will drop at a hub together.
export class AddHubsAndManifests1786119888375 implements MigrationInterface {
  name = 'AddHubsAndManifests1786119888375';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "isHub" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchants" ADD "hubNodeId" uuid,
         ADD CONSTRAINT "FK_merchants_hub_node" FOREIGN KEY ("hubNodeId") REFERENCES "nodes"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "merchant_manifests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "reference" character varying(20) NOT NULL,
        "hubNodeId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "expectedDropAt" TIMESTAMP WITH TIME ZONE,
        "closedAt" TIMESTAMP WITH TIME ZONE,
        "receivedAt" TIMESTAMP WITH TIME ZONE,
        "receivedByUserId" uuid,
        "cancelledAt" TIMESTAMP WITH TIME ZONE,
        "createdByUserId" uuid,
        "createdByApiKeyId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_manifests" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_manifests_reference" UNIQUE ("reference"),
        CONSTRAINT "CHK_merchant_manifests_status" CHECK ("status" IN ('open', 'closed', 'received', 'cancelled')),
        CONSTRAINT "FK_merchant_manifests_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_manifests_hub" FOREIGN KEY ("hubNodeId") REFERENCES "nodes"("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_manifests_merchant" ON "merchant_manifests" ("merchantId", "mode", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_manifests_hub_expected" ON "merchant_manifests" ("hubNodeId")
         WHERE "status" IN ('open', 'closed')`,
    );
    // Every shipment the manifest declared (expected) or the hub scanned
    // in under it without it being declared (unexpected).
    await queryRunner.query(
      `CREATE TABLE "merchant_manifest_items" (
        "manifestId" uuid NOT NULL,
        "shipmentId" uuid NOT NULL,
        "expected" boolean NOT NULL DEFAULT true,
        "receivedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_merchant_manifest_items" PRIMARY KEY ("manifestId", "shipmentId"),
        CONSTRAINT "FK_merchant_manifest_items_manifest" FOREIGN KEY ("manifestId") REFERENCES "merchant_manifests"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_manifest_items_shipment" FOREIGN KEY ("shipmentId") REFERENCES "merchant_shipments"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_manifest_items_shipment" ON "merchant_manifest_items" ("shipmentId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchant_shipments" ADD CONSTRAINT "FK_merchant_shipments_manifest"
         FOREIGN KEY ("manifestId") REFERENCES "merchant_manifests"("id") ON DELETE SET NULL`,
    );
    // Hub scans resolve a merchant's reference or own barcode.
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipments_external_barcode" ON "merchant_shipments" ("externalBarcode")
         WHERE "externalBarcode" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipments_awaiting_reference" ON "merchant_shipments" ("reference")
         WHERE "status" = 'created'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_merchant_shipments_awaiting_reference"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_merchant_shipments_external_barcode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "merchant_shipments" DROP CONSTRAINT "FK_merchant_shipments_manifest"`,
    );
    await queryRunner.query(`DROP TABLE "merchant_manifest_items"`);
    await queryRunner.query(`DROP TABLE "merchant_manifests"`);
    await queryRunner.query(
      `ALTER TABLE "merchants" DROP CONSTRAINT "FK_merchants_hub_node", DROP COLUMN "hubNodeId"`,
    );
    await queryRunner.query(`ALTER TABLE "nodes" DROP COLUMN "isHub"`);
  }
}
