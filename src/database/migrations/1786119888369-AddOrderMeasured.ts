import { MigrationInterface, QueryRunner } from 'typeorm';

// What the origin counter measured at drop-off (plan D14, M4c2). Merchant
// parcels are re-priced on it together with the real drop-off Node.
export class AddOrderMeasured1786119888369 implements MigrationInterface {
  name = 'AddOrderMeasured1786119888369';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD "measured" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "measured"`);
  }
}
