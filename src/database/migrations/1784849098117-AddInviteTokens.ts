import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInviteTokens1784849098117 implements MigrationInterface {
  name = 'AddInviteTokens1784849098117';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "invite_tokens" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "tokenHash" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "usedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5a05a43816424a1abac69e1f8a5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_906800fcd3eb1875f60b3623e8" ON "invite_tokens"  ("tokenHash") `,
    );
    await queryRunner.query(
      `ALTER TABLE "invite_tokens" ADD CONSTRAINT "FK_bda143c647fb2ceb6450426f147" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invite_tokens" DROP CONSTRAINT "FK_bda143c647fb2ceb6450426f147"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_906800fcd3eb1875f60b3623e8"`,
    );
    await queryRunner.query(`DROP TABLE "invite_tokens"`);
  }
}
