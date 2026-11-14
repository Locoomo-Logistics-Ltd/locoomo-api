import { MigrationInterface, QueryRunner } from 'typeorm';

// Merchant API keys and their request log (plan M2, §3.2).
export class CreateApiKeys1786119888359 implements MigrationInterface {
  name = 'CreateApiKeys1786119888359';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "api_keys" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "kind" character varying NOT NULL,
        "name" character varying(60) NOT NULL,
        "prefix" character varying(8) NOT NULL,
        "last4" character varying(4) NOT NULL,
        "keyHash" character varying(64) NOT NULL,
        "scopes" text array NOT NULL DEFAULT '{}',
        "allowedIps" text array NOT NULL DEFAULT '{}',
        "allowedOrigins" text array NOT NULL DEFAULT '{}',
        "hidePrices" boolean NOT NULL DEFAULT false,
        "createdByUserId" uuid NOT NULL,
        "lastUsedAt" TIMESTAMP WITH TIME ZONE,
        "lastUsedIp" character varying(45),
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "revokedByUserId" uuid,
        "rolledFromKeyId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_keys" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_api_keys_hash" UNIQUE ("keyHash"),
        CONSTRAINT "CHK_api_keys_mode" CHECK ("mode" IN ('test', 'live')),
        CONSTRAINT "CHK_api_keys_kind" CHECK ("kind" IN ('secret', 'publishable')),
        CONSTRAINT "FK_api_keys_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_merchant_mode" ON "api_keys" ("merchantId", "mode")`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_api_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "apiKeyId" uuid NOT NULL,
        "mode" character varying NOT NULL,
        "method" character varying(10) NOT NULL,
        "path" character varying(300) NOT NULL,
        "statusCode" smallint NOT NULL,
        "durationMs" integer NOT NULL,
        "ip" character varying(45),
        "correlationId" character varying(64),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_api_requests" PRIMARY KEY ("id")
      )`,
    );
    // Dashboard list (newest first, cursor on createdAt+id).
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_api_requests_list" ON "merchant_api_requests" ("merchantId", "mode", "createdAt" DESC, "id" DESC)`,
    );
    // 30-day retention purge.
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_api_requests_created" ON "merchant_api_requests" ("createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "merchant_api_requests"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
  }
}
