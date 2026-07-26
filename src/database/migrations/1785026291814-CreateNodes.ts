import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNodes1785026291814 implements MigrationInterface {
  name = 'CreateNodes1785026291814';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."nodes_status_enum" AS ENUM('pending', 'active', 'inactive', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."nodes_onboardingtype_enum" AS ENUM('field_recruited', 'warm_lead', 'chain_partner', 'franchise', 'portal')`,
    );
    await queryRunner.query(
      `CREATE TABLE "nodes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" character varying NOT NULL, "address" character varying NOT NULL, "city" character varying NOT NULL, "state" character varying NOT NULL, "country" character varying NOT NULL DEFAULT 'Nigeria', "latitude" double precision NOT NULL, "longitude" double precision NOT NULL, "capacity" integer NOT NULL, "status" "public"."nodes_status_enum" NOT NULL DEFAULT 'pending', "onboardingType" "public"."nodes_onboardingtype_enum" NOT NULL, "operatingHours" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_682d6427523a0fa43d062ea03ee" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8019f2637b16f1e26cc06acc50" ON "nodes" ("status")`,
    );

    // Not TypeORM-mapped (see node.entity.ts) — written/read only via raw SQL
    // in NodesService, kept solely to give the proximity query a real
    // spatial index.
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD "location" geography(Point,4326) NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_nodes_location" ON "nodes" USING GIST ("location")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_nodes_location"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8019f2637b16f1e26cc06acc50"`,
    );
    await queryRunner.query(`DROP TABLE "nodes"`);
    await queryRunner.query(`DROP TYPE "public"."nodes_onboardingtype_enum"`);
    await queryRunner.query(`DROP TYPE "public"."nodes_status_enum"`);
  }
}
