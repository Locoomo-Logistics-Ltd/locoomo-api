import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeLocationCheck1786119888346 implements MigrationInterface {
  name = 'AddNodeLocationCheck1786119888346';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NULL = never checked (every Node created before this existed).
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "locationCheck" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "locationCheckedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "nodes" DROP COLUMN "locationCheckedAt"`,
    );
    await queryRunner.query(`ALTER TABLE "nodes" DROP COLUMN "locationCheck"`);
  }
}
