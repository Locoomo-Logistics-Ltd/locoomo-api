import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeVisibility1786119888343 implements MigrationInterface {
  name = 'AddNodeVisibility1786119888343';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "isPubliclyVisible" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nodes" DROP COLUMN "isPubliclyVisible"`,
    );
  }
}
