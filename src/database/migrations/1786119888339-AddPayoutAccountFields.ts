import { MigrationInterface, QueryRunner } from 'typeorm';

// Payout bank account fields on rider_profiles and node_operator_profiles —
// all nullable, no defaults. Null across all five means "not configured
// yet" (the GET /me payoutAccountConfigured signal); every existing row
// predates this feature and simply starts in that state.
export class AddPayoutAccountFields1786119888339 implements MigrationInterface {
  name = 'AddPayoutAccountFields1786119888339';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rider_profiles"
         ADD "payoutBankCode" character varying,
         ADD "payoutBankName" character varying,
         ADD "payoutAccountNumber" character varying,
         ADD "payoutAccountName" character varying,
         ADD "payoutAccountVerifiedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "node_operator_profiles"
         ADD "payoutBankCode" character varying,
         ADD "payoutBankName" character varying,
         ADD "payoutAccountNumber" character varying,
         ADD "payoutAccountName" character varying,
         ADD "payoutAccountVerifiedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "node_operator_profiles"
         DROP COLUMN "payoutAccountVerifiedAt",
         DROP COLUMN "payoutAccountName",
         DROP COLUMN "payoutAccountNumber",
         DROP COLUMN "payoutBankName",
         DROP COLUMN "payoutBankCode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rider_profiles"
         DROP COLUMN "payoutAccountVerifiedAt",
         DROP COLUMN "payoutAccountName",
         DROP COLUMN "payoutAccountNumber",
         DROP COLUMN "payoutBankName",
         DROP COLUMN "payoutBankCode"`,
    );
  }
}
