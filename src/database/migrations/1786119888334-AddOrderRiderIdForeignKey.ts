import { MigrationInterface, QueryRunner } from 'typeorm';

// Follow-up to AddOrderRiderId — that migration added the column but missed
// the FK constraint every other plain-uuid cross-module column on `orders`
// already has (FK_orders_consumerId, FK_orders_originNodeId, ...). Caught
// before Phase 1 shipped; fixed here rather than editing the already-applied
// migration.
export class AddOrderRiderIdForeignKey1786119888334 implements MigrationInterface {
  name = 'AddOrderRiderIdForeignKey1786119888334';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_riderId" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_riderId"`,
    );
  }
}
