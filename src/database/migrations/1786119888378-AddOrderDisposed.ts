import { MigrationInterface, QueryRunner } from 'typeorm';

// M6a: an abandoned merchant return can be disposed of (plan D20). Only adds
// the enum value (§11.7: ADD VALUE gets its own migration).
export class AddOrderDisposed1786119888378 implements MigrationInterface {
  name = 'AddOrderDisposed1786119888378';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "orders_status_enum" ADD VALUE IF NOT EXISTS 'disposed'`,
    );
  }

  // Postgres can't drop enum values. Left in place deliberately.
  public async down(): Promise<void> {}
}
