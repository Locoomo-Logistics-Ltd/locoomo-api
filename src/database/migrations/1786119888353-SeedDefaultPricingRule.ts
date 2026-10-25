import { MigrationInterface, QueryRunner } from 'typeorm';

// Fixed id so down() removes exactly this rule and nothing an Admin added.
const DEFAULT_RULE_ID = 'b1a5e9a0-5eed-4000-8000-000000000001';

// Gives an environment with no pricing rule a working default, so checkout
// can price orders out of the box. Placeholder economics until the
// Locoomo–Sendii pricing formula is agreed (see payments/domain/
// vehicle-pricing.ts for the derivation from Sendii sandbox quotes):
//
//   motorbike  ₦1,100 + ₦320 per road-km    (the rule's own base/per-km)
//   car        ₦2,500 + ₦780 per road-km    (explicit vehicle rate)
//   bicycle/van  default multipliers on the motorbike rate
//   destination Node fee  ₦300
//   road km ≈ straight-line km × 1.4 until a courier has measured the pair
//
// Does nothing if any pricing rule already exists — never overrides an
// Admin's — or if there's no Admin account to attribute it to (pricing
// rules record their author); create one then with POST /admin/pricing.
// Admins change prices the normal way afterwards: a newer rule supersedes
// this one.
export class SeedDefaultPricingRule1786119888353 implements MigrationInterface {
  name = 'SeedDefaultPricingRule1786119888353';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "pricing_rules"
         ("id", "baseFeeKobo", "perKmRateKobo", "destinationFeeKobo",
          "roadDistanceFactor", "vehicleRates", "createdByAdminId")
       SELECT $1, 110000, 32000, 30000, 1.4,
              '{"car": {"baseFeeKobo": 250000, "perKmRateKobo": 78000}}'::jsonb,
              admin.id
         FROM (SELECT id FROM "users" WHERE role = 'admin'
                ORDER BY "createdAt" ASC LIMIT 1) admin
        WHERE NOT EXISTS (SELECT 1 FROM "pricing_rules")`,
      [DEFAULT_RULE_ID],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "pricing_rules" WHERE id = $1`, [
      DEFAULT_RULE_ID,
    ]);
  }
}
