import { MigrationInterface, QueryRunner } from 'typeorm';

// Collection window (plan §5.4–5.5, D15): public holidays, the deadline
// and reminder count on orders, and why a parcel is being returned.
export class AddCollectionWindow1786119888362 implements MigrationInterface {
  name = 'AddCollectionWindow1786119888362';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "public_holidays" (
        "date" date NOT NULL,
        "name" character varying(100) NOT NULL,
        "createdByUserId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_public_holidays" PRIMARY KEY ("date")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "collectionDeadlineAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "collectionRemindersSent" smallint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "returnReason" character varying(40)`,
    );
    // Parcels already waiting when this ships get a full window from now
    // (they had no deadline before; returning them immediately would
    // surprise receivers who were told nothing about one).
    await queryRunner.query(
      `UPDATE "orders"
          SET "collectionDeadlineAt" = date_trunc('day', now() AT TIME ZONE 'Africa/Lagos' + interval '9 days')
                                       AT TIME ZONE 'Africa/Lagos' - interval '1 second'
        WHERE status = 'ready_for_collection'`,
    );
    // The collection-window job's queue. Plain (not CONCURRENTLY): this
    // repo runs migrations in one transaction (migrationsTransactionMode
    // 'all'), and the partial index only covers shelved parcels. Switch to
    // 'each' before orders grows large enough for index builds to hurt.
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_collection_deadline" ON "orders" ("collectionDeadlineAt") WHERE status = 'ready_for_collection'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_orders_collection_deadline"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "returnReason"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "collectionRemindersSent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "collectionDeadlineAt"`,
    );
    await queryRunner.query(`DROP TABLE "public_holidays"`);
  }
}
