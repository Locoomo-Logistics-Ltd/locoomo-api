import { numericTransformer } from '../../../../common/database/numeric-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ParcelSize } from '../../../../common/parcel-size.enum';
import { OrderStatus } from '../../domain/order-status.enum';

@Entity('orders')
export class OrderEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  trackingCode!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  paymentIntentId!: string;

  @Index()
  @Column({ type: 'uuid' })
  consumerId!: string;

  @Column({ type: 'uuid' })
  originNodeId!: string;

  @Column({ type: 'uuid' })
  destinationNodeId!: string;

  // Set by OrdersService.assignRider() once a Rider claims this order
  // (handoffs module) — null until then. Plain uuid, not a relation, same
  // cross-module-boundary reasoning as consumerId/originNodeId above.
  @Index()
  @Column({ type: 'uuid', nullable: true })
  riderId!: string | null;

  @Column({ type: 'varchar' })
  receiverFullName!: string;

  @Column({ type: 'varchar' })
  receiverEmail!: string;

  @Column({ type: 'varchar' })
  receiverPhone!: string;

  @Column({ type: 'varchar', length: 500 })
  parcelDescription!: string;

  @Column({ type: 'enum', enum: ParcelSize, enumName: 'parcel_size_enum' })
  parcelSize!: ParcelSize;

  // Parcel details beyond the size class (all optional) and the vehicle
  // they resolve to — see ParcelDetailsDto / VehicleSelectionService.
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 1,
    nullable: true,
    transformer: numericTransformer,
  })
  weightKg!: number | null;

  @Column({ type: 'int', nullable: true })
  lengthCm!: number | null;

  @Column({ type: 'int', nullable: true })
  widthCm!: number | null;

  @Column({ type: 'int', nullable: true })
  heightCm!: number | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  handling!: string[];

  @Column({ type: 'varchar', nullable: true })
  vehicleClass!: string | null;

  @Column({ type: 'int' })
  amountKobo!: number;

  // Denormalized off the PaymentIntent's snapshotted feeBreakdown — needed
  // here (not just on PaymentIntent) because ConfirmCollectionService only
  // has the Order at completion time, and revenue-split recording must use
  // the fee that was actually charged, never a recomputed current rate.
  @Column({ type: 'int', default: 0 })
  destinationFeeKobo!: number;

  @Index()
  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.AWAITING_DROP_OFF,
  })
  status!: OrderStatus;

  // Where the parcel sits right now and the number written on it there —
  // set when a Node takes it in (drop-off at origin, intake at
  // destination), cleared when it leaves (rider pickup, collection). Both
  // NULL while it's with a rider or gone. Managed only by OrdersService.
  @Column({ type: 'uuid', nullable: true })
  shelfNodeId!: string | null;

  @Column({ type: 'int', nullable: true })
  shelfNumber!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
