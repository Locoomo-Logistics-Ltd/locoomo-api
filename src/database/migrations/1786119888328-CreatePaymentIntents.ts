import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentIntents1786119888328 implements MigrationInterface {
  name = 'CreatePaymentIntents1786119888328';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."payment_intents_status_enum" AS ENUM('pending', 'paid', 'failed', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_intents_provider_enum" AS ENUM('paystack')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_intents" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "consumerId" uuid NOT NULL, "originNodeId" uuid NOT NULL, "destinationNodeId" uuid NOT NULL, "receiverEmail" character varying NOT NULL, "parcelDescription" character varying(500) NOT NULL, "feeBreakdown" jsonb NOT NULL, "amountKobo" integer NOT NULL, "status" "public"."payment_intents_status_enum" NOT NULL DEFAULT 'pending', "provider" "public"."payment_intents_provider_enum" NOT NULL, "providerReference" character varying, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "paidAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_payment_intents" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payment_intents_consumerId" ON "payment_intents" ("consumerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payment_intents_status" ON "payment_intents" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payment_intents_expiresAt" ON "payment_intents" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_payment_intents_providerReference" ON "payment_intents" ("providerReference") WHERE "providerReference" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD CONSTRAINT "FK_payment_intents_consumerId" FOREIGN KEY ("consumerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD CONSTRAINT "FK_payment_intents_originNodeId" FOREIGN KEY ("originNodeId") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD CONSTRAINT "FK_payment_intents_destinationNodeId" FOREIGN KEY ("destinationNodeId") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT "FK_payment_intents_destinationNodeId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT "FK_payment_intents_originNodeId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP CONSTRAINT "FK_payment_intents_consumerId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_payment_intents_providerReference"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_payment_intents_expiresAt"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_payment_intents_status"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_payment_intents_consumerId"`,
    );
    await queryRunner.query(`DROP TABLE "payment_intents"`);
    await queryRunner.query(
      `DROP TYPE "public"."payment_intents_provider_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."payment_intents_status_enum"`);
  }
}
