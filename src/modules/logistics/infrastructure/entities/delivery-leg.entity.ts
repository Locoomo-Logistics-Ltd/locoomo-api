import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  DeliveryLegStatus,
  DeliveryLegType,
  VehicleClass,
} from '../../domain/delivery-leg';

// One courier's attempt at moving an order's parcel between two Nodes. An
// order can collect several over its life (a courier found no rider →
// retried → fell back to in-house riders; later a return leg), so history is
// kept; a partial unique index (migration) allows only one *active* leg per
// order. orderId is a plain uuid, no relation — module boundary rule.
// status/providerKey are varchar, not Postgres enums, so a new courier or
// state never needs an ALTER TYPE.
@Entity('delivery_legs')
@Index('IDX_delivery_legs_external', ['providerKey', 'externalId'])
@Index('IDX_delivery_legs_one_active', ['orderId'], {
  unique: true,
  where: `"status" IN ('requested', 'assigned', 'picked_up', 'returning')`,
})
export class DeliveryLegEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index('IDX_delivery_legs_order')
  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'varchar' })
  legType!: DeliveryLegType;

  @Column({ type: 'varchar' })
  providerKey!: string;

  @Column({ type: 'varchar' })
  status!: DeliveryLegStatus;

  // 1 for the first leg of this type on the order, then 2, 3, … per retry
  // or fallback.
  @Column({ type: 'int', default: 1 })
  attemptNumber!: number;

  // The provider's own id/status/sequence for this delivery — null for
  // in-house riders.
  @Column({ type: 'varchar', nullable: true })
  externalId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  providerStatus!: string | null;

  @Column({ type: 'int', nullable: true })
  providerSequence!: number | null;

  @Column({ type: 'varchar', nullable: true })
  vehicleClass!: VehicleClass | null;

  // In-house riders: the rider's user id (capacity slot owner). Null for
  // external couriers, whose riders aren't Locoomo users.
  @Index('IDX_delivery_legs_courier_user')
  @Column({ type: 'uuid', nullable: true })
  courierUserId!: string | null;

  // Snapshot of who's carrying it, shown to Node staff (and name only to
  // the sender).
  @Column({ type: 'varchar', nullable: true })
  courierName!: string | null;

  @Column({ type: 'varchar', nullable: true })
  courierPhone!: string | null;

  @Column({ type: 'varchar', nullable: true })
  courierVehicle!: string | null;

  @Column({ type: 'varchar', nullable: true })
  trackingUrl!: string | null;

  @Column({ type: 'int', nullable: true })
  etaMinutes!: number | null;

  // Courier economics, integer kobo: what was quoted at dispatch, what was
  // finally charged, and surcharges (extra attempts, returns).
  @Column({ type: 'int', nullable: true })
  quotedKobo!: number | null;

  @Column({ type: 'int', nullable: true })
  actualKobo!: number | null;

  @Column({ type: 'int', default: 0 })
  surchargeKobo!: number;

  @Column({ type: 'varchar', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
