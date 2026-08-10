import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeCurrentCount1786119888325 implements MigrationInterface {
  name = 'AddNodeCurrentCount1786119888325';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "currentCount" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "nodes" DROP COLUMN "currentCount"`);
  }
}
