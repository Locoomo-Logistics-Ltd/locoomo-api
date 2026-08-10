import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReceiverAndParcelDetails1786119888330 implements MigrationInterface {
  name = 'AddReceiverAndParcelDetails1786119888330';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."parcel_size_enum" AS ENUM('small', 'medium', 'large', 'extra_large')`,
    );

    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD "receiverFullName" character varying`,
    );
    await queryRunner.query(
      `UPDATE "payment_intents" SET "receiverFullName" = 'Unknown' WHERE "receiverFullName" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "receiverFullName" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD "receiverPhone" character varying`,
    );
    await queryRunner.query(
      `UPDATE "payment_intents" SET "receiverPhone" = '+2340000000000' WHERE "receiverPhone" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "receiverPhone" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ADD "parcelSize" "public"."parcel_size_enum"`,
    );
    await queryRunner.query(
      `UPDATE "payment_intents" SET "parcelSize" = 'small' WHERE "parcelSize" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" ALTER COLUMN "parcelSize" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "orders" ADD "receiverFullName" character varying`,
    );
    await queryRunner.query(
      `UPDATE "orders" SET "receiverFullName" = 'Unknown' WHERE "receiverFullName" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "receiverFullName" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "receiverPhone" character varying`,
    );
    await queryRunner.query(
      `UPDATE "orders" SET "receiverPhone" = '+2340000000000' WHERE "receiverPhone" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "receiverPhone" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "parcelSize" "public"."parcel_size_enum"`,
    );
    await queryRunner.query(
      `UPDATE "orders" SET "parcelSize" = 'small' WHERE "parcelSize" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "parcelSize" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "parcelSize"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "receiverPhone"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "receiverFullName"`,
    );

    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN "parcelSize"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN "receiverPhone"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_intents" DROP COLUMN "receiverFullName"`,
    );

    await queryRunner.query(`DROP TYPE "public"."parcel_size_enum"`);
  }
}
