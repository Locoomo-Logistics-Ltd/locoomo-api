import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLoginLockoutToUsers1784800591305 implements MigrationInterface {
  name = 'AddLoginLockoutToUsers1784800591305';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "failedLoginAttempts" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "lockedUntil" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "lockedUntil"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "failedLoginAttempts"`,
    );
  }
}
