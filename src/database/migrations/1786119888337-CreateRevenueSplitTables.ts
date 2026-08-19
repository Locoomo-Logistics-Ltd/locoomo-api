import { MigrationInterface, QueryRunner } from 'typeorm';

// revenue_split_rules: append-only, same shape as pricing_rules — a new
// ratio is a new row, never an UPDATE, so a historical order's split stays
// explainable after the ratio changes.
// revenue_split_entries: one row per party per completed order (rider,
// origin Node, platform). orderId gets a real FK to orders(id), matching
// order_events' precedent (not handoff_codes' — that table's "no FK"
// comment doesn't actually match the rest of this codebase, and money
// records warrant the referential-integrity guarantee regardless).
// partyId is polymorphic (User id for rider, Node id for node, null for
// platform) so no FK is possible there. UNIQUE (orderId, partyType) is
// defense-in-depth alongside the application-level idempotency guard —
// guarantees no code path can ever double-record an order's revenue.
export class CreateRevenueSplitTables1786119888337 implements MigrationInterface {
  name = 'CreateRevenueSplitTables1786119888337';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "revenue_split_rules" (
         "id" uuid NOT NULL DEFAULT gen_random_uuid(),
         "riderPercent" integer NOT NULL,
         "nodePercent" integer NOT NULL,
         "platformPercent" integer NOT NULL,
         "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "createdByAdminId" uuid NOT NULL,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_revenue_split_rules" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_revenue_split_rules_effectiveFrom" ON "revenue_split_rules" ("effectiveFrom")`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_rules" ADD CONSTRAINT "FK_revenue_split_rules_createdByAdminId" FOREIGN KEY ("createdByAdminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."revenue_split_party_type_enum" AS ENUM('rider', 'node', 'platform')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payout_status_enum" AS ENUM('pending', 'paid')`,
    );
    await queryRunner.query(
      `CREATE TABLE "revenue_split_entries" (
         "id" uuid NOT NULL DEFAULT gen_random_uuid(),
         "orderId" uuid NOT NULL,
         "partyType" "public"."revenue_split_party_type_enum" NOT NULL,
         "partyId" uuid,
         "amountKobo" integer NOT NULL,
         "splitRuleId" uuid NOT NULL,
         "payoutStatus" "public"."payout_status_enum" NOT NULL DEFAULT 'pending',
         "paidAt" TIMESTAMP WITH TIME ZONE,
         "paidByAdminId" uuid,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_revenue_split_entries" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_revenue_split_entries_orderId_partyType" UNIQUE ("orderId", "partyType")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_revenue_split_entries_orderId" ON "revenue_split_entries" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_revenue_split_entries_partyType_partyId" ON "revenue_split_entries" ("partyType", "partyId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ADD CONSTRAINT "FK_revenue_split_entries_orderId" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ADD CONSTRAINT "FK_revenue_split_entries_splitRuleId" FOREIGN KEY ("splitRuleId") REFERENCES "revenue_split_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ADD CONSTRAINT "FK_revenue_split_entries_paidByAdminId" FOREIGN KEY ("paidByAdminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" DROP CONSTRAINT "FK_revenue_split_entries_paidByAdminId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" DROP CONSTRAINT "FK_revenue_split_entries_splitRuleId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" DROP CONSTRAINT "FK_revenue_split_entries_orderId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_revenue_split_entries_partyType_partyId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_revenue_split_entries_orderId"`,
    );
    await queryRunner.query(`DROP TABLE "revenue_split_entries"`);
    await queryRunner.query(`DROP TYPE "public"."payout_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."revenue_split_party_type_enum"`,
    );

    await queryRunner.query(
      `ALTER TABLE "revenue_split_rules" DROP CONSTRAINT "FK_revenue_split_rules_createdByAdminId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_revenue_split_rules_effectiveFrom"`,
    );
    await queryRunner.query(`DROP TABLE "revenue_split_rules"`);
  }
}
