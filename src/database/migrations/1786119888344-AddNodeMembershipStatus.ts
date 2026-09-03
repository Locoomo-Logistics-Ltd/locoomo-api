import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeMembershipStatus1786119888344 implements MigrationInterface {
  name = 'AddNodeMembershipStatus1786119888344';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."node_memberships_status_enum" AS ENUM('active', 'removed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "node_memberships" ADD "status" "public"."node_memberships_status_enum" NOT NULL DEFAULT 'active'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "node_memberships" DROP COLUMN "status"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."node_memberships_status_enum"`,
    );
  }
}
