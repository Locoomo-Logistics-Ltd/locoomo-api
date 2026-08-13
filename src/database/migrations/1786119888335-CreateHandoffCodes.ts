import { MigrationInterface, QueryRunner } from 'typeorm';

// Backs all three handoff-code moments (rider pickup, rider arrival,
// receiver collection — see HandoffCodeType) with one table. No FK to
// orders(id) — cross-module reference, same reasoning every other
// Order-referencing plain-uuid column in this codebase already follows;
// Order rows are never deleted anyway (append-only event history), so
// there's no dangling-reference risk to guard against.
export class CreateHandoffCodes1786119888335 implements MigrationInterface {
  name = 'CreateHandoffCodes1786119888335';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."handoff_code_type_enum" AS ENUM('rider_pickup', 'rider_arrival', 'receiver_collection')`,
    );
    await queryRunner.query(
      `CREATE TABLE "handoff_codes" (
         "id" uuid NOT NULL DEFAULT gen_random_uuid(),
         "orderId" uuid NOT NULL,
         "type" "public"."handoff_code_type_enum" NOT NULL,
         "codeHash" character varying NOT NULL,
         "requestedByUserId" uuid,
         "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
         "usedAt" TIMESTAMP WITH TIME ZONE,
         "failedAttempts" integer NOT NULL DEFAULT 0,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_handoff_codes" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handoff_codes_orderId" ON "handoff_codes" ("orderId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_handoff_codes_orderId"`);
    await queryRunner.query(`DROP TABLE "handoff_codes"`);
    await queryRunner.query(`DROP TYPE "public"."handoff_code_type_enum"`);
  }
}
