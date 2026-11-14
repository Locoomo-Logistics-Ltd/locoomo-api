import { MigrationInterface, QueryRunner } from 'typeorm';

// New order statuses (plan §5.3): refused at drop-off, and exception (lost
// or damaged in our custody). Only adds enum values: Postgres allows that
// inside the migration transaction, as long as nothing in the same
// transaction uses them (§11.7: ADD VALUE gets its own migration).
export class AddOrderRefusedAndException1786119888364 implements MigrationInterface {
  name = 'AddOrderRefusedAndException1786119888364';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "orders_status_enum" ADD VALUE IF NOT EXISTS 'refused'`,
    );
    await queryRunner.query(
      `ALTER TYPE "orders_status_enum" ADD VALUE IF NOT EXISTS 'exception'`,
    );
  }

  // Postgres can't drop enum values; rows using them would need a
  // migration of their own first. Left in place deliberately.
  public async down(): Promise<void> {}
}
