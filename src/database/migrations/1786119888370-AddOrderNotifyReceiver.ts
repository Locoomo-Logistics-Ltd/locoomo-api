import { MigrationInterface, QueryRunner } from 'typeorm';

// Who tells the receiver about a parcel (plan D19, M4d): Locoomo, the
// merchant (who relays the collection code), or both. Existing orders are
// Locoomo's to notify.
export class AddOrderNotifyReceiver1786119888370 implements MigrationInterface {
  name = 'AddOrderNotifyReceiver1786119888370';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "notifyReceiver" character varying NOT NULL DEFAULT 'locoomo'`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_notify_receiver"
         CHECK ("notifyReceiver" IN ('locoomo', 'merchant', 'both'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_notify_receiver"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "notifyReceiver"`,
    );
  }
}
