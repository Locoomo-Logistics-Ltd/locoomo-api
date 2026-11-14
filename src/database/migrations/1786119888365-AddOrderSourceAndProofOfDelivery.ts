import { MigrationInterface, QueryRunner } from 'typeorm';

// Orders that come from merchants (plan §5.1), and the extra facts M3
// records on every order: proof of delivery (§5.4), why a parcel was
// refused at drop-off, and lost/damaged exceptions (§5.3).
export class AddOrderSourceAndProofOfDelivery1786119888365 implements MigrationInterface {
  name = 'AddOrderSourceAndProofOfDelivery1786119888365';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "source" character varying NOT NULL DEFAULT 'consumer'`,
    );
    await queryRunner.query(`ALTER TABLE "orders" ADD "merchantId" uuid`);
    // Merchant parcels have no consumer, no payment intent (paid from the
    // merchant's wallet), and may have no receiver email (SMS / relay).
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "consumerId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "paymentIntentId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "receiverEmail" DROP NOT NULL`,
    );
    // Added NOT VALID then validated (§11.7): no long lock while it checks.
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_source" CHECK (
         ("source" = 'consumer' AND "consumerId" IS NOT NULL AND "paymentIntentId" IS NOT NULL)
         OR ("source" = 'merchant' AND "merchantId" IS NOT NULL)
       ) NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" VALIDATE CONSTRAINT "CHK_orders_source"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_merchant" ON "orders" ("merchantId") WHERE "merchantId" IS NOT NULL`,
    );

    // Proof of delivery.
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "collectedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "collectionMethod" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "collectorName" character varying(150)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "collectionPhotoPublicId" character varying(255)`,
    );
    // ID-check collection: wrong attempts so far (5 allowed).
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "idCheckFailedAttempts" smallint NOT NULL DEFAULT 0`,
    );
    // { reason, note, photoPublicId, at } / { type, note, at, byUserId }.
    await queryRunner.query(`ALTER TABLE "orders" ADD "refusal" jsonb`);
    await queryRunner.query(`ALTER TABLE "orders" ADD "exception" jsonb`);
    // Orders collected before this: their completion time is the best
    // record we have, by code.
    await queryRunner.query(
      `UPDATE "orders" o SET "collectedAt" = e."createdAt", "collectionMethod" = 'code'
         FROM (SELECT "orderId", max("createdAt") AS "createdAt" FROM order_events
                WHERE type = 'collected_by_receiver' GROUP BY "orderId") e
        WHERE o.id = e."orderId" AND o.status = 'completed'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [
      'exception',
      'refusal',
      'idCheckFailedAttempts',
      'collectionPhotoPublicId',
      'collectorName',
      'collectionMethod',
      'collectedAt',
    ]) {
      await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "${column}"`);
    }
    await queryRunner.query(`DROP INDEX "IDX_orders_merchant"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "receiverEmail" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "paymentIntentId" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "consumerId" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "merchantId"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "source"`);
  }
}
