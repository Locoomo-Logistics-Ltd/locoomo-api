import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrders1786119888329 implements MigrationInterface {
  name = 'CreateOrders1786119888329';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."orders_status_enum" AS ENUM('awaiting_drop_off', 'parcel_received_at_origin', 'rider_assigned', 'in_transit', 'arrived_at_destination', 'ready_for_collection', 'completed', 'cancelled', 'disputed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "paymentIntentId" uuid NOT NULL, "consumerId" uuid NOT NULL, "originNodeId" uuid NOT NULL, "destinationNodeId" uuid NOT NULL, "receiverEmail" character varying NOT NULL, "parcelDescription" character varying(500) NOT NULL, "amountKobo" integer NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'awaiting_drop_off', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_orders" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_orders_paymentIntentId" ON "orders" ("paymentIntentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_consumerId" ON "orders" ("consumerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_status" ON "orders" ("status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_paymentIntentId" FOREIGN KEY ("paymentIntentId") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_consumerId" FOREIGN KEY ("consumerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_originNodeId" FOREIGN KEY ("originNodeId") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_destinationNodeId" FOREIGN KEY ("destinationNodeId") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );

    await queryRunner.query(
      `CREATE TABLE "order_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "orderId" uuid NOT NULL, "type" character varying NOT NULL, "payload" jsonb NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_order_events" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_order_events_orderId" ON "order_events" ("orderId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_events" ADD CONSTRAINT "FK_order_events_orderId" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_events" DROP CONSTRAINT "FK_order_events_orderId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_order_events_orderId"`);
    await queryRunner.query(`DROP TABLE "order_events"`);

    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_destinationNodeId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_originNodeId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_consumerId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_paymentIntentId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_consumerId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_paymentIntentId"`);
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
  }
}
