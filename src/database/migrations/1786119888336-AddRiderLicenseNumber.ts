import { MigrationInterface, QueryRunner } from 'typeorm';

// Nullable — required going forward by OnboardRiderDto for every new rider,
// but not backfilled for any rider who onboarded before this field existed
// (no "update my license number" flow exists, and inventing a backfill
// value for real PII isn't this migration's call to make).
export class AddRiderLicenseNumber1786119888336 implements MigrationInterface {
  name = 'AddRiderLicenseNumber1786119888336';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rider_profiles" ADD "licenseNumber" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rider_profiles" DROP COLUMN "licenseNumber"`,
    );
  }
}
