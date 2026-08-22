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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
