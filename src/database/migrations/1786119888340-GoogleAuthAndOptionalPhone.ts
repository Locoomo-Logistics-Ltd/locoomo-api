import { MigrationInterface, QueryRunner } from 'typeorm';

// Two independent changes bundled together since they're both part of the
// same feature: (1) googleId — nullable, unique, set only for accounts
// created via Google sign-in; a plain unique index already permits multiple
// NULLs in Postgres, no partial index needed. (2) phone dropped from NOT
// NULL — no longer collected at registration (neither password nor Google
// signup can reliably obtain it there), moved to a post-signup PATCH
// /users/me step instead. Every existing row already has a phone value, so
// this only changes what's allowed going forward.
export class GoogleAuthAndOptionalPhone1786119888340 implements MigrationInterface {
  name = 'GoogleAuthAndOptionalPhone1786119888340';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "googleId" character varying`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_users_googleId" ON "users" ("googleId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "phone" SET NOT NULL`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_users_googleId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "googleId"`);
  }
}
