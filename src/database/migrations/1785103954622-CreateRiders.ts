import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRiders1785103954622 implements MigrationInterface {
  name = 'CreateRiders1785103954622';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."rider_profiles_status_enum" AS ENUM('pending', 'active', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TABLE "rider_profiles" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "currentEmployer" character varying NOT NULL, "status" "public"."rider_profiles_status_enum" NOT NULL DEFAULT 'pending', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_bec1afad599cabe486f80dbcbf2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_fa7f813fe33853d3b8e856d79e" ON "rider_profiles" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d0e33c9806b8d3b937708148d2" ON "rider_profiles" ("status")`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."rider_verification_documents_documenttype_enum" AS ENUM('rating_screenshot')`,
    );
    await queryRunner.query(
      `CREATE TABLE "rider_verification_documents" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "riderProfileId" uuid NOT NULL, "documentType" "public"."rider_verification_documents_documenttype_enum" NOT NULL, "cloudinaryPublicId" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9d2b26938a202d6d0e9ae276129" PRIMARY KEY ("id"))`,
    );

    // Not TypeORM relations (see entity comments) — hand-written for real
    // referential integrity, same reasoning as node_operator_profiles' FKs.
    await queryRunner.query(
      `ALTER TABLE "rider_profiles" ADD CONSTRAINT "FK_rider_profiles_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rider_verification_documents" ADD CONSTRAINT "FK_rider_verification_documents_riderProfileId" FOREIGN KEY ("riderProfileId") REFERENCES "rider_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rider_verification_documents" DROP CONSTRAINT "FK_rider_verification_documents_riderProfileId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rider_profiles" DROP CONSTRAINT "FK_rider_profiles_userId"`,
    );
    await queryRunner.query(`DROP TABLE "rider_verification_documents"`);
    await queryRunner.query(
      `DROP TYPE "public"."rider_verification_documents_documenttype_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d0e33c9806b8d3b937708148d2"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fa7f813fe33853d3b8e856d79e"`,
    );
    await queryRunner.query(`DROP TABLE "rider_profiles"`);
    await queryRunner.query(`DROP TYPE "public"."rider_profiles_status_enum"`);
  }
}
