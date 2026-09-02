import { MigrationInterface, QueryRunner } from 'typeorm';

// node_operator_profiles -> node_memberships: "profile" stopped being an
// accurate name once a row can represent either the owner of a Node or
// (Phase 2) staff helping run one. Every existing row is correctly an
// owner, hence the DEFAULT — and the old unique(userId) index (the literal
// DB-level "one Node per operator" enforcement) is replaced by a composite
// unique(userId, nodeId), which is what actually allows one operator to own
// multiple Nodes while still preventing a duplicate membership row for the
// same (user, Node) pair. FK/PK constraint names are left as originally
// generated (FK_node_operator_profiles_userId etc.) — RENAME TO doesn't
// rename constraints in Postgres, and renaming them for cosmetics only adds
// migration risk for zero functional benefit.
export class CreateNodeMemberships1786119888341 implements MigrationInterface {
  name = 'CreateNodeMemberships1786119888341';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "node_operator_profiles" RENAME TO "node_memberships"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."node_memberships_roleatnode_enum" AS ENUM('owner', 'staff')`,
    );
    await queryRunner.query(
      `ALTER TABLE "node_memberships" ADD "roleAtNode" "public"."node_memberships_roleatnode_enum" NOT NULL DEFAULT 'owner'`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5a67a307c3c55f26e130b5743b"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_node_memberships_userId_nodeId" ON "node_memberships" ("userId", "nodeId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_node_memberships_userId_nodeId"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_5a67a307c3c55f26e130b5743b" ON "node_memberships" ("userId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "node_memberships" DROP COLUMN "roleAtNode"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."node_memberships_roleatnode_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "node_memberships" RENAME TO "node_operator_profiles"`,
    );
  }
}
