import { MigrationInterface, QueryRunner } from 'typeorm';

// Append-only audit trail (common/audit) — admin actions and sensitive
// merchant actions. Plan §11 / E12.
export class CreateAuditEvents1786119888354 implements MigrationInterface {
  name = 'CreateAuditEvents1786119888354';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actorType" character varying NOT NULL,
        "actorId" uuid,
        "actorRole" character varying,
        "merchantId" uuid,
        "action" character varying NOT NULL,
        "targetType" character varying,
        "targetId" character varying,
        "before" jsonb,
        "after" jsonb,
        "metadata" jsonb,
        "ip" character varying,
        "userAgent" character varying(500),
        "correlationId" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_events" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_audit_events_actor_type" CHECK ("actorType" IN ('user', 'api_key', 'system'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_events_target" ON "audit_events" ("targetType", "targetId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_events_actor" ON "audit_events" ("actorId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_events_merchant" ON "audit_events" ("merchantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_events_action" ON "audit_events" ("action", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_events"`);
  }
}
