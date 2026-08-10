import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePricingRules1786119888327 implements MigrationInterface {
  name = 'CreatePricingRules1786119888327';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "pricing_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "baseFeeKobo" integer NOT NULL, "perKmRateKobo" integer NOT NULL, "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "createdByAdminId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_pricing_rules" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pricing_rules_effectiveFrom" ON "pricing_rules" ("effectiveFrom")`,
    );
    await queryRunner.query(
      `ALTER TABLE "pricing_rules" ADD CONSTRAINT "FK_pricing_rules_createdByAdminId" FOREIGN KEY ("createdByAdminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pricing_rules" DROP CONSTRAINT "FK_pricing_rules_createdByAdminId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_pricing_rules_effectiveFrom"`,
    );
    await queryRunner.query(`DROP TABLE "pricing_rules"`);
  }
}
