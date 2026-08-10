import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdempotencyKeys1786119888326 implements MigrationInterface {
  name = 'CreateIdempotencyKeys1786119888326';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "scope" character varying NOT NULL, "key" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_idempotency_keys_scope_key" ON "idempotency_keys" ("scope", "key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_idempotency_keys_scope_key"`,
    );
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
  }
}
