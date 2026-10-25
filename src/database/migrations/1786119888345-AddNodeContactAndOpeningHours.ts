import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeContactAndOpeningHours1786119888345 implements MigrationInterface {
  name = 'AddNodeContactAndOpeningHours1786119888345';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Both nullable: required for new Nodes at the DTO layer, but existing
    // Nodes predate them. operatingHours (free text) stays as-is until every
    // client has moved to openingHours.
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "contactPhone" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "nodes" ADD "openingHours" jsonb`);

    // Seed contactPhone from the owner's own phone so existing Nodes have a
    // reachable number on day one — owners can replace it with a counter
    // phone afterwards. Only copies values already in E.164 shape; anything
    // else stays NULL rather than storing a number we can't vouch for.
    await queryRunner.query(
      `UPDATE "nodes" n
          SET "contactPhone" = u.phone
         FROM "node_memberships" m
         JOIN "users" u ON u.id = m."userId"
        WHERE m."nodeId" = n.id
          AND m."roleAtNode" = 'owner'
          AND m.status = 'active'
          AND u.phone ~ '^\\+[1-9][0-9]{7,14}$'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "nodes" DROP COLUMN "openingHours"`);
    await queryRunner.query(`ALTER TABLE "nodes" DROP COLUMN "contactPhone"`);
  }
}
