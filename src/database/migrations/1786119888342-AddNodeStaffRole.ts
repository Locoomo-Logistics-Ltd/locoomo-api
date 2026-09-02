import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeStaffRole1786119888342 implements MigrationInterface {
  name = 'AddNodeStaffRole1786119888342';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."users_role_enum" ADD VALUE 'node_staff'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres has no ALTER TYPE ... DROP VALUE — swap in a copy of the
    // enum without node_staff. `role` has no DEFAULT to drop/restore
    // (unlike users_status_enum's down-migration precedent), it's NOT NULL
    // with no default.
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum_old" AS ENUM('consumer', 'node_operator', 'rider', 'admin')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE "public"."users_role_enum_old" USING "role"::"text"::"public"."users_role_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."users_role_enum_old" RENAME TO "users_role_enum"`,
    );
  }
}
