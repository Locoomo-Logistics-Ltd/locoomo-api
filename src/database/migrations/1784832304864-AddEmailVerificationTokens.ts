import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmailVerificationTokens1784832304864 implements MigrationInterface {
  name = 'AddEmailVerificationTokens1784832304864';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "email_verification_tokens" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "tokenHash" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "usedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_417a095bbed21c2369a6a01ab9a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_90489f8f3368c45f461e90efbe" ON "email_verification_tokens"  ("tokenHash") `,
    );
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "FK_10f285d038feb767bf7c2da14b3" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" DROP CONSTRAINT "FK_10f285d038feb767bf7c2da14b3"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_90489f8f3368c45f461e90efbe"`,
    );
    await queryRunner.query(`DROP TABLE "email_verification_tokens"`);
  }
}
