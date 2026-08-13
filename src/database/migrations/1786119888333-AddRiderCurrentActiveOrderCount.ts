import { MigrationInterface, QueryRunner } from 'typeorm';

// Direct mirror of AddNodeCurrentCount — same atomic-counter-under-a-lock
// pattern (NodesService.reserveCapacitySlot), applied to the rider side for
// the "max 3 concurrent deliveries" cap (handoffs' accept-order flow).
export class AddRiderCurrentActiveOrderCount1786119888333 implements MigrationInterface {
  name = 'AddRiderCurrentActiveOrderCount1786119888333';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rider_profiles" ADD "currentActiveOrderCount" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rider_profiles" DROP COLUMN "currentActiveOrderCount"`,
    );
  }
}
