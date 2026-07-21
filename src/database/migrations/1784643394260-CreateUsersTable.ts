import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersTable1784643394260 implements MigrationInterface {
  name = 'CreateUsersTable1784643394260';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('consumer', 'node_operator', 'rider', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum" AS ENUM('invited', 'active', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "email" character varying NOT NULL, "passwordHash" character varying, "firstName" character varying NOT NULL, "lastName" character varying NOT NULL, "phone" character varying NOT NULL, "role" "public"."users_role_enum" NOT NULL, "status" "public"."users_status_enum" NOT NULL DEFAULT 'invited', "consentAcceptedAt" TIMESTAMP WITH TIME ZONE, "emailVerifiedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users"  ("email") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
  }
}
