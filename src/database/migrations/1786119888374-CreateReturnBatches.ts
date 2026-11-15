import { MigrationInterface, QueryRunner } from 'typeorm';

// M4f2: merchant return batches (plan §6.3, MERCHANT_API.md §11.3). One
// code hands back every return in the batch at its Node. A shipment is in
// at most one active (open) batch.
export class CreateReturnBatches1786119888374 implements MigrationInterface {
  name = 'CreateReturnBatches1786119888374';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchant_return_batches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "reference" character varying(20) NOT NULL,
        "nodeId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "codeHash" character varying NOT NULL,
        "codeSealed" text NOT NULL,
        "codeExpiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "failedAttempts" integer NOT NULL DEFAULT 0,
        "createdByUserId" uuid,
        "createdByApiKeyId" uuid,
        "collectedAt" TIMESTAMP WITH TIME ZONE,
        "collectedByUserId" uuid,
        "collectorName" character varying(100),
        "cancelledAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_return_batches" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_return_batches_reference" UNIQUE ("reference"),
        CONSTRAINT "CHK_merchant_return_batches_status" CHECK ("status" IN ('open', 'collected', 'cancelled')),
        CONSTRAINT "FK_merchant_return_batches_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_return_batches_node" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_return_batches_merchant" ON "merchant_return_batches" ("merchantId", "mode", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_return_batches_node_open" ON "merchant_return_batches" ("nodeId") WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE TABLE "merchant_return_batch_items" (
        "batchId" uuid NOT NULL,
        "shipmentId" uuid NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "collectedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_merchant_return_batch_items" PRIMARY KEY ("batchId", "shipmentId"),
        CONSTRAINT "FK_merchant_return_batch_items_batch" FOREIGN KEY ("batchId") REFERENCES "merchant_return_batches"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_return_batch_items_shipment" FOREIGN KEY ("shipmentId") REFERENCES "merchant_shipments"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_merchant_return_batch_items_active" ON "merchant_return_batch_items" ("shipmentId") WHERE "active"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "merchant_return_batch_items"`);
    await queryRunner.query(`DROP TABLE "merchant_return_batches"`);
  }
}
