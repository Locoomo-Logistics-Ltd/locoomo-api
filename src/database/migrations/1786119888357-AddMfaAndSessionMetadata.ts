import { MigrationInterface, QueryRunner } from 'typeorm';

// M1a account security: TOTP 2FA (+ recovery codes), mandatory-2FA marker
// for admins, and device metadata for the sessions list.
export class AddMfaAndSessionMetadata1786119888357 implements MigrationInterface {
  name = 'AddMfaAndSessionMetadata1786119888357';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mfa_factors" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "secretSealed" character varying NOT NULL,
        "confirmedAt" TIMESTAMP WITH TIME ZONE,
        "lastUsedStep" bigint,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mfa_factors" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mfa_factors_user" UNIQUE ("userId"),
        CONSTRAINT "FK_mfa_factors_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "mfa_recovery_codes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "codeHash" character varying NOT NULL,
        "usedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mfa_recovery_codes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mfa_recovery_codes_user_hash" UNIQUE ("userId", "codeHash"),
        CONSTRAINT "FK_mfa_recovery_codes_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mfa_recovery_codes_user" ON "mfa_recovery_codes" ("userId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "users" ADD "mfaRequiredSince" TIMESTAMP WITH TIME ZONE`,
    );
    // Every existing admin's 14-day 2FA enrolment window starts now.
    await queryRunner.query(
      `UPDATE "users" SET "mfaRequiredSince" = now() WHERE "role" = 'admin'`,
    );

    await queryRunner.query(
      `ALTER TABLE "refresh_tokens"
         ADD "userAgent" character varying(500),
         ADD "ip" character varying`,
    );
    // Sessions list groups a user's live families.
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_family" ON "refresh_tokens" ("userId", "familyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_user_family"`);
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "ip", DROP COLUMN "userAgent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "mfaRequiredSince"`,
    );
    await queryRunner.query(`DROP TABLE "mfa_recovery_codes"`);
    await queryRunner.query(`DROP TABLE "mfa_factors"`);
  }
}
