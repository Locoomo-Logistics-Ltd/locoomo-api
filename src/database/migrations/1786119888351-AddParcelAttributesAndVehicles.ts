import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddParcelAttributesAndVehicles1786119888351 implements MigrationInterface {
  name = 'AddParcelAttributesAndVehicles1786119888351';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Parcel details captured at checkout (decision 5), on the intent and
    // copied onto the order. All optional at first so existing clients keep
    // working; vehicleClass is what they resolve to.
    for (const table of ['payment_intents', 'orders']) {
      await queryRunner.query(
        `ALTER TABLE "${table}"
           ADD "weightKg" numeric(6,1),
           ADD "lengthCm" integer,
           ADD "widthCm" integer,
           ADD "heightCm" integer,
           ADD "handling" text array NOT NULL DEFAULT '{}',
           ADD "vehicleClass" character varying`,
      );
    }

    // Which vehicle a parcel needs: the lowest-rank enabled class whose
    // limits it fits. Placeholder limits until couriers confirm theirs.
    await queryRunner.query(
      `CREATE TABLE "vehicle_class_rules" (
         "vehicleClass" character varying NOT NULL,
         "rank" integer NOT NULL,
         "enabled" boolean NOT NULL DEFAULT true,
         "parcelSizes" text array NOT NULL,
         "maxWeightKg" double precision NOT NULL,
         "maxLongestSideCm" integer NOT NULL,
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_vehicle_class_rules" PRIMARY KEY ("vehicleClass"))`,
    );
    await queryRunner.query(
      `INSERT INTO "vehicle_class_rules"
         ("vehicleClass", "rank", "enabled", "parcelSizes", "maxWeightKg", "maxLongestSideCm")
       VALUES
         ('bicycle',   1, false, '{small}',                            5,   40),
         ('motorbike', 2, true,  '{small,medium}',                     20,  60),
         ('car',       3, true,  '{small,medium,large,extra_large}',   50,  120),
         ('van',       4, false, '{small,medium,large,extra_large}',   500, 250)`,
    );

    // Pricing by vehicle and road distance. The rule's own base/per-km
    // fields are the motorbike rate; other classes use vehicleRates
    // overrides or default multipliers. Existing rules keep a factor of 1.0
    // so their prices don't change underneath them; new rules default to
    // 1.4 (median road/straight-line ratio measured between Lagos Nodes).
    await queryRunner.query(
      `ALTER TABLE "pricing_rules"
         ADD "roadDistanceFactor" double precision NOT NULL DEFAULT 1.4,
         ADD "vehicleRates" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `UPDATE "pricing_rules" SET "roadDistanceFactor" = 1.0`,
    );

    // Road distance between two Nodes, learned from courier quotes —
    // preferred over the straight-line estimate once known.
    await queryRunner.query(
      `CREATE TABLE "node_route_distances" (
         "originNodeId" uuid NOT NULL,
         "destinationNodeId" uuid NOT NULL,
         "roadDistanceMeters" integer NOT NULL,
         "source" character varying NOT NULL,
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_node_route_distances" PRIMARY KEY ("originNodeId", "destinationNodeId"),
         CONSTRAINT "FK_node_route_distances_origin" FOREIGN KEY ("originNodeId") REFERENCES "nodes"("id"),
         CONSTRAINT "FK_node_route_distances_destination" FOREIGN KEY ("destinationNodeId") REFERENCES "nodes"("id"))`,
    );

    // Most of the delivery fee a courier may cost before the order is
    // routed elsewhere instead (null = no cap). The rider allocation is 60%;
    // allowing Sendii up to 75% caps what the platform absorbs per order.
    await queryRunner.query(
      `ALTER TABLE "logistics_providers" ADD "maxCostShare" double precision`,
    );
    await queryRunner.query(
      `UPDATE "logistics_providers" SET "maxCostShare" = 0.75 WHERE key = 'sendii'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "logistics_providers" DROP COLUMN "maxCostShare"`,
    );
    await queryRunner.query(`DROP TABLE "node_route_distances"`);
    await queryRunner.query(
      `ALTER TABLE "pricing_rules" DROP COLUMN "vehicleRates", DROP COLUMN "roadDistanceFactor"`,
    );
    await queryRunner.query(`DROP TABLE "vehicle_class_rules"`);
    for (const table of ['orders', 'payment_intents']) {
      await queryRunner.query(
        `ALTER TABLE "${table}"
           DROP COLUMN "vehicleClass", DROP COLUMN "handling",
           DROP COLUMN "heightCm", DROP COLUMN "widthCm",
           DROP COLUMN "lengthCm", DROP COLUMN "weightKg"`,
      );
    }
  }
}
