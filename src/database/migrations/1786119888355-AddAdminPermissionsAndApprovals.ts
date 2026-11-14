import { MigrationInterface, QueryRunner } from 'typeorm';

// Admin permissions within the `admin` role, and maker-checker approval
// requests (plan E12).
export class AddAdminPermissionsAndApprovals1786119888355 implements MigrationInterface {
  name = 'AddAdminPermissionsAndApprovals1786119888355';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "adminPermissions" text array NOT NULL DEFAULT '{}'`,
    );
    // Everyone who is an admin today keeps doing everything they can do
    // today: grant `super`, then narrow individual admins down through
    // PATCH /admin/admins/:id/permissions.
    await queryRunner.query(
      `UPDATE "users" SET "adminPermissions" = ARRAY['super'] WHERE "role" = 'admin'`,
    );

    await queryRunner.query(
      `CREATE TABLE "approval_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "action" character varying NOT NULL,
        "status" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "summary" character varying(300) NOT NULL,
        "reason" character varying(1000) NOT NULL,
        "merchantId" uuid,
        "requestedByUserId" uuid NOT NULL,
        "decidedByUserId" uuid,
        "decisionNote" character varying(1000),
        "decidedAt" TIMESTAMP WITH TIME ZONE,
        "result" jsonb,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_approval_requests" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_approval_requests_status" CHECK ("status" IN ('pending', 'executed', 'rejected', 'cancelled', 'expired')),
        -- The whole point of maker-checker: the database refuses a request
        -- decided by the admin who raised it, even if a code path forgets.
        CONSTRAINT "CHK_approval_requests_distinct_checker" CHECK (
          "status" IN ('cancelled') OR "decidedByUserId" IS NULL OR "decidedByUserId" <> "requestedByUserId"
        ),
        CONSTRAINT "FK_approval_requests_requested_by" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id"),
        CONSTRAINT "FK_approval_requests_decided_by" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_approval_requests_status" ON "approval_requests" ("status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_approval_requests_merchant" ON "approval_requests" ("merchantId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "approval_requests"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "adminPermissions"`,
    );
  }
}
