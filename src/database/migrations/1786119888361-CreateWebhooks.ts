import { MigrationInterface, QueryRunner } from 'typeorm';

// Merchant webhooks: endpoints, events and deliveries (plan §9, M2).
export class CreateWebhooks1786119888361 implements MigrationInterface {
  name = 'CreateWebhooks1786119888361';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "webhook_endpoints" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "url" character varying(2048) NOT NULL,
        "description" character varying(200),
        "events" text array NOT NULL DEFAULT '{}',
        "enabled" boolean NOT NULL DEFAULT true,
        "disabledReason" character varying(300),
        "secretSealed" text NOT NULL,
        "previousSecretSealed" text,
        "previousSecretExpiresAt" TIMESTAMP WITH TIME ZONE,
        "failingSince" TIMESTAMP WITH TIME ZONE,
        "lastSuccessAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_endpoints" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_webhook_endpoints_mode" CHECK ("mode" IN ('test', 'live')),
        CONSTRAINT "FK_webhook_endpoints_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_endpoints_merchant_mode" ON "webhook_endpoints" ("merchantId", "mode")`,
    );

    await queryRunner.query(
      `CREATE TABLE "webhook_events" (
        "id" character varying(40) NOT NULL,
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "type" character varying(60) NOT NULL,
        "body" text NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_webhook_events_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_events_merchant_created" ON "webhook_events" ("merchantId", "mode", "createdAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "eventId" character varying(40) NOT NULL,
        "endpointId" uuid NOT NULL,
        "merchantId" uuid NOT NULL,
        "status" character varying NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "lockedUntil" TIMESTAMP WITH TIME ZONE,
        "lastAttemptAt" TIMESTAMP WITH TIME ZONE,
        "responseStatus" smallint,
        "responseBody" text,
        "error" character varying(500),
        "durationMs" integer,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_webhook_deliveries_status" CHECK ("status" IN ('pending', 'delivering', 'succeeded', 'failed')),
        CONSTRAINT "FK_webhook_deliveries_event" FOREIGN KEY ("eventId") REFERENCES "webhook_events"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_webhook_deliveries_endpoint" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE
      )`,
    );
    // The worker's queue: only unfinished deliveries.
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_due" ON "webhook_deliveries" ("nextAttemptAt") WHERE "status" IN ('pending', 'delivering')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_endpoint" ON "webhook_deliveries" ("endpointId", "createdAt" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_merchant" ON "webhook_deliveries" ("merchantId", "createdAt" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
    await queryRunner.query(`DROP TABLE "webhook_events"`);
    await queryRunner.query(`DROP TABLE "webhook_endpoints"`);
  }
}
