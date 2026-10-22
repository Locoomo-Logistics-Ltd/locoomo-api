import { MigrationInterface, QueryRunner } from 'typeorm';

const RETURN_STATUSES = [
  'return_initiated',
  'return_in_transit',
  'returned_to_origin',
  'ready_for_sender_collection',
  'return_completed',
];

export class AddReturns1786119888350 implements MigrationInterface {
  name = 'AddReturns1786119888350';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Failed deliveries go back to the origin Pickup Station, where the
    // sender collects them (decision 4).
    for (const status of RETURN_STATUSES) {
      await queryRunner.query(
        `ALTER TYPE "public"."orders_status_enum" ADD VALUE '${status}'`,
      );
    }
    // The sender's code for collecting a returned parcel.
    await queryRunner.query(
      `ALTER TYPE "public"."handoff_code_type_enum" ADD VALUE 'sender_collection'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres can't drop enum values; rebuild the types without them.
    await queryRunner.query(
      `DELETE FROM "handoff_codes" WHERE "type" = 'sender_collection'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."handoff_code_type_enum" RENAME TO "handoff_code_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."handoff_code_type_enum" AS ENUM('rider_pickup', 'rider_arrival', 'receiver_collection')`,
    );
    await queryRunner.query(
      `ALTER TABLE "handoff_codes" ALTER COLUMN "type" TYPE "public"."handoff_code_type_enum" USING "type"::text::"public"."handoff_code_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."handoff_code_type_enum_old"`);

    await queryRunner.query(
      `UPDATE "orders" SET status = 'in_transit' WHERE status IN (${RETURN_STATUSES.map((s) => `'${s}'`).join(', ')})`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."orders_status_enum" RENAME TO "orders_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_status_enum" AS ENUM('awaiting_drop_off', 'parcel_received_at_origin', 'rider_assigned', 'in_transit', 'arrived_at_destination', 'ready_for_collection', 'completed', 'cancelled', 'disputed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "status" TYPE "public"."orders_status_enum" USING "status"::text::"public"."orders_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'awaiting_drop_off'`,
    );
    await queryRunner.query(`DROP TYPE "public"."orders_status_enum_old"`);
  }
}
