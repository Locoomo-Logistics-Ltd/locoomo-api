import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutboxEventsTable1784815951799 implements MigrationInterface {
  name = 'CreateOutboxEventsTable1784815951799';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."outbox_events_status_enum" AS ENUM('pending', 'sent', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "outbox_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "eventType" character varying NOT NULL, "payload" jsonb NOT NULL, "status" "public"."outbox_events_status_enum" NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "lastError" character varying, "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6689a16c00d09b8089f6237f1d2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_733fafe6b0ec20ec7c93fdbbca" ON "outbox_events"  ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_886535dad79ff24d84fcfed7a3" ON "outbox_events"  ("nextAttemptAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_886535dad79ff24d84fcfed7a3"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_733fafe6b0ec20ec7c93fdbbca"`,
    );
    await queryRunner.query(`DROP TABLE "outbox_events"`);
    await queryRunner.query(`DROP TYPE "public"."outbox_events_status_enum"`);
  }
}
