import { MigrationInterface, QueryRunner } from 'typeorm';

// destinationFeeKobo: a third pricing_rules lever (alongside baseFeeKobo/
// perKmRateKobo) — a flat, admin-configurable fee added to totalKobo at
// checkout, paid out entirely to the destination Node on order completion
// rather than folded into the rider/origin-Node/platform 60/20/20 split
// (see RevenueSplitPartyType.DESTINATION_NODE). DEFAULT 0 on both new
// columns, same "safe zero baseline" treatment as nodes.currentCount, so
// existing pricing_rules/orders rows (which predate this fee entirely) stay
// valid without inventing a backfill value.
//
// The new enum value follows CreateNodeOperatorProfiles' precedent: ADD
// VALUE as the first statement, never referenced by any row written later
// in this same migration/transaction (Postgres allows adding an enum value
// inside a transaction, just not using it within that same transaction).
export class AddDestinationNodeFee1786119888338 implements MigrationInterface {
  name = 'AddDestinationNodeFee1786119888338';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."revenue_split_party_type_enum" ADD VALUE 'destination_node'`,
    );

    await queryRunner.query(
      `ALTER TABLE "pricing_rules" ADD "destinationFeeKobo" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "destinationFeeKobo" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "destinationFeeKobo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pricing_rules" DROP COLUMN "destinationFeeKobo"`,
    );

    // Postgres has no ALTER TYPE ... DROP VALUE — swap in a copy of the
    // enum without destination_node, same technique as
    // CreateNodeOperatorProfiles' users_status_enum rollback. Note: this
    // fails (as it should) if any revenue_split_entries row already has
    // partyType = 'destination_node' — same inherent limitation as that
    // precedent, not something to work around here.
    await queryRunner.query(
      `CREATE TYPE "public"."revenue_split_party_type_enum_old" AS ENUM('rider', 'node', 'platform')`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ALTER COLUMN "partyType" TYPE "public"."revenue_split_party_type_enum_old" USING "partyType"::"text"::"public"."revenue_split_party_type_enum_old"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."revenue_split_party_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."revenue_split_party_type_enum_old" RENAME TO "revenue_split_party_type_enum"`,
    );
  }
}
