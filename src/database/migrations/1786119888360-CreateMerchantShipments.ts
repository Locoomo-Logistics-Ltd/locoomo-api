import { MigrationInterface, QueryRunner } from 'typeorm';

// Merchant shipments and their event history (plan §6, M2: test mode;
// live shipments link to orders in M4).
export class CreateMerchantShipments1786119888360 implements MigrationInterface {
  name = 'CreateMerchantShipments1786119888360';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchant_shipments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "reference" character varying(64) NOT NULL,
        "trackingCode" character varying(20) NOT NULL,
        "status" character varying NOT NULL,
        "sequence" integer NOT NULL DEFAULT 1,
        "statusChangedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "originType" character varying NOT NULL,
        "origin" jsonb NOT NULL,
        "destination" jsonb NOT NULL,
        "destinationChanged" boolean NOT NULL DEFAULT false,
        "receiverName" character varying(100) NOT NULL,
        "receiverPhone" character varying(20) NOT NULL,
        "receiverEmail" character varying(254),
        "parcel" jsonb NOT NULL,
        "measured" jsonb,
        "externalBarcode" character varying(64),
        "manifestId" uuid,
        "quotedKobo" integer NOT NULL,
        "chargedKobo" integer,
        "feeState" character varying NOT NULL,
        "feeBreakdown" jsonb NOT NULL,
        "vehicleClass" character varying(40) NOT NULL,
        "dropDeadline" TIMESTAMP WITH TIME ZONE NOT NULL,
        "collectionDeadline" TIMESTAMP WITH TIME ZONE,
        "collectedAt" TIMESTAMP WITH TIME ZONE,
        "collectionMethod" character varying,
        "collectorName" character varying(100),
        "returnInfo" jsonb,
        "exceptionInfo" jsonb,
        "notifyReceiver" character varying NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "orderId" uuid,
        "createdByKeyId" uuid,
        "createdByUserId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_shipments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_shipments_tracking" UNIQUE ("trackingCode"),
        CONSTRAINT "UQ_merchant_shipments_reference" UNIQUE ("merchantId", "mode", "reference"),
        CONSTRAINT "CHK_merchant_shipments_mode" CHECK ("mode" IN ('test', 'live')),
        CONSTRAINT "CHK_merchant_shipments_status" CHECK ("status" IN ('created', 'received', 'in_transit', 'ready_for_collection', 'collected', 'returning', 'return_ready', 'returned', 'cancelled', 'expired', 'refused', 'exception', 'disposed')),
        CONSTRAINT "CHK_merchant_shipments_fee_state" CHECK ("feeState" IN ('held', 'charged', 'released')),
        CONSTRAINT "CHK_merchant_shipments_notify" CHECK ("notifyReceiver" IN ('locoomo', 'merchant', 'both')),
        -- E14: test codes never look like live ones.
        CONSTRAINT "CHK_merchant_shipments_test_code" CHECK (("mode" = 'test') = ("trackingCode" LIKE 'LCT-%')),
        CONSTRAINT "FK_merchant_shipments_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
    // Default list: newest first.
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipments_created" ON "merchant_shipments" ("merchantId", "mode", "createdAt" DESC, "id" DESC)`,
    );
    // Sync: updatedSince, oldest change first.
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipments_updated" ON "merchant_shipments" ("merchantId", "mode", "updatedAt", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipments_status" ON "merchant_shipments" ("merchantId", "mode", "status")`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_shipment_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "shipmentId" uuid NOT NULL,
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "sequence" integer NOT NULL,
        "type" character varying(40) NOT NULL,
        "nodeName" character varying(200),
        "data" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_shipment_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_merchant_shipment_events_shipment" FOREIGN KEY ("shipmentId") REFERENCES "merchant_shipments"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_shipment_events_shipment" ON "merchant_shipment_events" ("shipmentId", "sequence")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "merchant_shipment_events"`);
    await queryRunner.query(`DROP TABLE "merchant_shipments"`);
  }
}
