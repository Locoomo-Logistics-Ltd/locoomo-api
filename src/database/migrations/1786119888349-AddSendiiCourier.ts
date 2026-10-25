import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSendiiCourier1786119888349 implements MigrationInterface {
  name = 'AddSendiiCourier1786119888349';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Off until switched on per environment (start with pilotNodeIds).
    // Preferred over in-house riders (priority 10 < 1000); two attempts per
    // order (Sendii asks partners to re-create after dispatch_failed); gives
    // up on finding a rider after 20 minutes; Sendii serves 100 m – 80 km.
    await queryRunner.query(
      `INSERT INTO "logistics_providers"
         ("key", "label", "enabled", "priority", "maxAttempts",
          "assignTimeoutMinutes", "minDistanceKm", "maxDistanceKm")
       VALUES ('sendii', 'Sendii', false, 10, 2, 20, 0.1, 80)`,
    );

    // Inbound courier webhooks, stored before they're processed: dedupe on
    // the provider's event id (they redeliver freely), an audit trail, and
    // replay if processing fails.
    await queryRunner.query(
      `CREATE TABLE "logistics_inbound_events" (
         "id" uuid NOT NULL DEFAULT gen_random_uuid(),
         "providerKey" character varying NOT NULL,
         "eventId" character varying NOT NULL,
         "externalId" character varying,
         "payload" jsonb NOT NULL,
         "processedAt" TIMESTAMP WITH TIME ZONE,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_logistics_inbound_events" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_logistics_inbound_events_event" UNIQUE ("providerKey", "eventId"),
         CONSTRAINT "FK_logistics_inbound_events_provider" FOREIGN KEY ("providerKey") REFERENCES "logistics_providers"("key"))`,
    );

    // Pilot settlement for courier-delivered orders: the rider's share is
    // recorded as a courier allocation that is never paid out to anyone.
    await queryRunner.query(
      `ALTER TYPE "public"."revenue_split_party_type_enum" ADD VALUE 'courier_allocation'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."payout_status_enum" ADD VALUE 'not_payable'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "revenue_split_entries" WHERE "partyType" = 'courier_allocation'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."payout_status_enum" RENAME TO "payout_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payout_status_enum" AS ENUM('pending', 'paid')`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ALTER COLUMN "payoutStatus" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ALTER COLUMN "payoutStatus" TYPE "public"."payout_status_enum" USING "payoutStatus"::text::"public"."payout_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ALTER COLUMN "payoutStatus" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(`DROP TYPE "public"."payout_status_enum_old"`);
    await queryRunner.query(
      `ALTER TYPE "public"."revenue_split_party_type_enum" RENAME TO "revenue_split_party_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."revenue_split_party_type_enum" AS ENUM('rider', 'node', 'platform', 'destination_node')`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_split_entries" ALTER COLUMN "partyType" TYPE "public"."revenue_split_party_type_enum" USING "partyType"::text::"public"."revenue_split_party_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."revenue_split_party_type_enum_old"`,
    );

    await queryRunner.query(`DROP TABLE "logistics_inbound_events"`);
    await queryRunner.query(
      `DELETE FROM "delivery_legs" WHERE "providerKey" = 'sendii'`,
    );
    await queryRunner.query(
      `DELETE FROM "logistics_providers" WHERE "key" = 'sendii'`,
    );
  }
}
