import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNodeOperatorProfiles1785032136391 implements MigrationInterface {
  name = 'CreateNodeOperatorProfiles1785032136391';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."users_status_enum" ADD VALUE 'pending_review'`,
    );

    await queryRunner.query(
      `CREATE TABLE "node_operator_profiles" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "nodeId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5e732307a0cdd2ddba7f7a52f2d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_5a67a307c3c55f26e130b5743b" ON "node_operator_profiles" ("userId")`,
    );

    // Not a TypeORM relation (see the entity comment) — hand-written for
    // real referential integrity, since the auto-generator has no way to
    // discover a cross-module FK from a plain uuid column.
    await queryRunner.query(
      `ALTER TABLE "node_operator_profiles" ADD CONSTRAINT "FK_node_operator_profiles_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "node_operator_profiles" ADD CONSTRAINT "FK_node_operator_profiles_nodeId" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "node_operator_profiles" DROP CONSTRAINT "FK_node_operator_profiles_nodeId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "node_operator_profiles" DROP CONSTRAINT "FK_node_operator_profiles_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5a67a307c3c55f26e130b5743b"`,
    );
    await queryRunner.query(`DROP TABLE "node_operator_profiles"`);

    // Postgres has no ALTER TYPE ... DROP VALUE — swap in a copy of the
    // enum without pending_review. The column's DEFAULT has to be dropped
    // before the type swap (Postgres can't auto-cast a default expression
    // to the new type) and restored after.
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum_old" AS ENUM('invited', 'active', 'suspended')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "public"."users_status_enum_old" USING "status"::"text"::"public"."users_status_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."users_status_enum_old" RENAME TO "users_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'invited'`,
    );
  }
}
