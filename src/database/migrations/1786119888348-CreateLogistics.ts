import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLogistics1786119888348 implements MigrationInterface {
  name = 'CreateLogistics1786119888348';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "logistics_providers" (
         "key" character varying NOT NULL,
         "label" character varying NOT NULL,
         "enabled" boolean NOT NULL DEFAULT false,
         "priority" integer NOT NULL,
         "maxAttempts" integer NOT NULL DEFAULT 1,
         "assignTimeoutMinutes" integer,
         "minDistanceKm" double precision,
         "maxDistanceKm" double precision,
         "pilotNodeIds" uuid array,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_logistics_providers" PRIMARY KEY ("key"))`,
    );
    // In-house riders: always on, always eligible, tried last — the fallback.
    await queryRunner.query(
      `INSERT INTO "logistics_providers" ("key", "label", "enabled", "priority", "maxAttempts")
       VALUES ('in_house', 'Locoomo rider', true, 1000, 1)`,
    );

    await queryRunner.query(
      `CREATE TABLE "delivery_legs" (
         "id" uuid NOT NULL DEFAULT gen_random_uuid(),
         "orderId" uuid NOT NULL,
         "legType" character varying NOT NULL,
         "providerKey" character varying NOT NULL,
         "status" character varying NOT NULL,
         "attemptNumber" integer NOT NULL DEFAULT 1,
         "externalId" character varying,
         "providerStatus" character varying,
         "providerSequence" integer,
         "vehicleClass" character varying,
         "courierUserId" uuid,
         "courierName" character varying,
         "courierPhone" character varying,
         "courierVehicle" character varying,
         "trackingUrl" character varying,
         "etaMinutes" integer,
         "quotedKobo" integer,
         "actualKobo" integer,
         "surchargeKobo" integer NOT NULL DEFAULT 0,
         "failureReason" character varying,
         "endedAt" TIMESTAMP WITH TIME ZONE,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_delivery_legs" PRIMARY KEY ("id"),
         CONSTRAINT "FK_delivery_legs_order" FOREIGN KEY ("orderId") REFERENCES "orders"("id"),
         CONSTRAINT "FK_delivery_legs_provider" FOREIGN KEY ("providerKey") REFERENCES "logistics_providers"("key"),
         CONSTRAINT "FK_delivery_legs_courier_user" FOREIGN KEY ("courierUserId") REFERENCES "users"("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_delivery_legs_order" ON "delivery_legs" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_delivery_legs_external" ON "delivery_legs" ("providerKey", "externalId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_delivery_legs_courier_user" ON "delivery_legs" ("courierUserId")`,
    );
    // At most one leg in progress per order.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_delivery_legs_one_active" ON "delivery_legs" ("orderId")
         WHERE "status" IN ('requested', 'assigned', 'picked_up', 'returning')`,
    );

    // Orders already past drop-off were all carried by in-house riders —
    // give each one the leg it would have had, so in-flight orders keep
    // working and history is complete.
    await queryRunner.query(
      `INSERT INTO "delivery_legs"
         ("orderId", "legType", "providerKey", "status", "courierUserId",
          "courierName", "courierPhone", "endedAt", "createdAt", "updatedAt")
       SELECT o.id, 'forward', 'in_house',
              CASE o.status
                WHEN 'parcel_received_at_origin' THEN 'requested'
                WHEN 'rider_assigned' THEN 'assigned'
                WHEN 'in_transit' THEN 'picked_up'
                ELSE 'delivered'
              END,
              o."riderId",
              CASE WHEN u.id IS NULL THEN NULL
                   ELSE u."firstName" || ' ' || left(u."lastName", 1) || '.' END,
              u.phone,
              CASE WHEN o.status IN ('arrived_at_destination', 'ready_for_collection', 'completed')
                   THEN o."updatedAt" END,
              o."updatedAt", o."updatedAt"
         FROM "orders" o
         LEFT JOIN "users" u ON u.id = o."riderId"
        WHERE o.status IN ('parcel_received_at_origin', 'rider_assigned', 'in_transit',
                           'arrived_at_destination', 'ready_for_collection', 'completed')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "delivery_legs"`);
    await queryRunner.query(`DROP TABLE "logistics_providers"`);
  }
}
