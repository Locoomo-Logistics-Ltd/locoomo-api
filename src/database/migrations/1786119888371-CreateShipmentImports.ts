import { MigrationInterface, QueryRunner } from 'typeorm';

// Shipment imports (MERCHANT_API.md §7.3, M4d): up to 10,000 shipments from a
// JSON list or CSV, created in the background one row at a time.
export class CreateShipmentImports1786119888371 implements MigrationInterface {
  name = 'CreateShipmentImports1786119888371';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "shipment_imports" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "source" character varying NOT NULL,
        "status" character varying NOT NULL,
        "fileName" character varying(255),
        "totalRows" integer NOT NULL,
        "createdCount" integer NOT NULL DEFAULT 0,
        "failedCount" integer NOT NULL DEFAULT 0,
        "failureReason" character varying(500),
        "createdByKeyId" uuid,
        "createdByUserId" uuid,
        "lockedUntil" TIMESTAMP WITH TIME ZONE,
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shipment_imports" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_shipment_imports_mode" CHECK ("mode" IN ('test', 'live')),
        CONSTRAINT "CHK_shipment_imports_source" CHECK ("source" IN ('json', 'csv')),
        CONSTRAINT "CHK_shipment_imports_status" CHECK ("status" IN ('queued', 'processing', 'done', 'failed')),
        CONSTRAINT "FK_shipment_imports_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_shipment_imports_merchant_created" ON "shipment_imports" ("merchantId", "mode", "createdAt")`,
    );
    // The worker's queue.
    await queryRunner.query(
      `CREATE INDEX "IDX_shipment_imports_open" ON "shipment_imports" ("createdAt") WHERE "status" IN ('queued', 'processing')`,
    );

    await queryRunner.query(
      `CREATE TABLE "shipment_import_rows" (
        "importId" uuid NOT NULL,
        "index" integer NOT NULL,
        "line" integer,
        "status" character varying NOT NULL DEFAULT 'pending',
        "input" jsonb NOT NULL,
        "shipmentId" uuid,
        "error" jsonb,
        CONSTRAINT "PK_shipment_import_rows" PRIMARY KEY ("importId", "index"),
        CONSTRAINT "CHK_shipment_import_rows_status" CHECK ("status" IN ('pending', 'created', 'failed')),
        CONSTRAINT "FK_shipment_import_rows_import" FOREIGN KEY ("importId") REFERENCES "shipment_imports"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_shipment_import_rows_pending" ON "shipment_import_rows" ("importId", "index") WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "shipment_import_rows"`);
    await queryRunner.query(`DROP TABLE "shipment_imports"`);
  }
}
