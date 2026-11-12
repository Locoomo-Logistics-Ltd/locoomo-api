import { MigrationInterface, QueryRunner } from 'typeorm';

// HTTP Idempotency-Key replay (common/idempotency/idempotency.interceptor):
// store the request hash and the response so a retry gets the original
// result. Nullable — existing "seen" markers (webhooks, handoff scans) keep
// working unchanged and never expire.
export class ExtendIdempotencyKeysForReplay1786119888356 implements MigrationInterface {
  name = 'ExtendIdempotencyKeysForReplay1786119888356';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys"
         ADD "requestHash" character varying,
         ADD "responseStatus" integer,
         ADD "responseBody" jsonb,
         ADD "expiresAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_idempotency_keys_expires_at" ON "idempotency_keys" ("expiresAt") WHERE "expiresAt" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_idempotency_keys_expires_at"`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys"
         DROP COLUMN "expiresAt",
         DROP COLUMN "responseBody",
         DROP COLUMN "responseStatus",
         DROP COLUMN "requestHash"`,
    );
  }
}
