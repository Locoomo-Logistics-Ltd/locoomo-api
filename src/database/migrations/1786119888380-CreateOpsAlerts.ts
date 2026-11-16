import { MigrationInterface, QueryRunner } from 'typeorm';

// M6b: platform health alerts (plan §10). One open alert per check while
// it's breached, so ops are emailed once (and reminded) rather than on
// every run.
export class CreateOpsAlerts1786119888380 implements MigrationInterface {
  name = 'CreateOpsAlerts1786119888380';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ops_alerts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key" character varying(60) NOT NULL,
        "openedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastAlertedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastValue" double precision NOT NULL,
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_ops_alerts" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ops_alerts_open" ON "ops_alerts" ("key") WHERE "resolvedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ops_alerts"`);
  }
}
