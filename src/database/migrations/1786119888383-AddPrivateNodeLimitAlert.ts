import { MigrationInterface, QueryRunner } from 'typeorm';

// Private Nodes: the Lagos month ('YYYY-MM') in which ops were last told
// the Node went over its monthly order limit, so they hear once a month.
export class AddPrivateNodeLimitAlert1786119888383 implements MigrationInterface {
  name = 'AddPrivateNodeLimitAlert1786119888383';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "privateLimitAlertedMonth" character varying(7)`,
    );
    // The monthly count looks orders up by Node and creation time.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_origin_created" ON "orders" ("originNodeId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_destination_created" ON "orders" ("destinationNodeId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_orders_destination_created"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orders_origin_created"`);
    await queryRunner.query(
      `ALTER TABLE "nodes" DROP COLUMN "privateLimitAlertedMonth"`,
    );
  }
}
