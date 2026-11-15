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

  // Consumer orders only (merchant parcels are paid from the wallet).
  @Index({ unique: true })
  @Column({ type: 'uuid', nullable: true })
  paymentIntentId!: string | null;

  // Consumer orders only.
  @Index()
  @Column({ type: 'uuid', nullable: true })
  consumerId!: string | null;

  // Who the order is for (plan §5.1). CHECK: consumer orders carry
  // consumerId + paymentIntentId, merchant orders merchantId.
  @Column({ type: 'varchar', default: 'consumer' })
  source!: 'consumer' | 'merchant';

  @Column({ type: 'uuid', nullable: true })
  merchantId!: string | null;

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

  // May be absent on merchant parcels (SMS / merchant relay instead).
  @Column({ type: 'varchar', nullable: true })
  receiverEmail!: string | null;

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

  // End of the collection window (D15): set when shelved at the
  // destination. Past it, an uncollected parcel goes back to the sender.
  @Column({ type: 'timestamptz', nullable: true })
  collectionDeadlineAt!: Date | null;

  @Column({ type: 'smallint', default: 0 })
  collectionRemindersSent!: number;

  // Why it's going back: not_collected | delivery_failed | merchant_request.
  @Column({ type: 'varchar', length: 40, nullable: true })
  returnReason!: string | null;

  // The merchant asked for it back while it was on its way: the
  // destination turns it round on arrival instead of offering it to the
  // buyer (OrdersService.requestReturn).
  @Column({ type: 'timestamptz', nullable: true })
  returnRequestedAt!: Date | null;

  // What the origin counter measured at drop-off (merchant parcels are
  // re-priced on it, D14). Any of weightKg, lengthCm, widthCm, heightCm, size.
  @Column({ type: 'jsonb', nullable: true })
  measured!: Record<string, unknown> | null;

  // Who tells the receiver (plan D19): `locoomo` (email/SMS), `merchant`
  // (the merchant relays the code; we stay silent) or `both`.
  @Column({ type: 'varchar', default: 'locoomo' })
  notifyReceiver!: 'locoomo' | 'merchant' | 'both';

  // A merchant's volume discount already taken off amountKobo (plan E7).
  // Earnings and the courier cost cap use amountKobo + discountKobo; only
  // the platform share pays for it.
  @Column({ type: 'int', default: 0 })
  discountKobo!: number;

  // Whether this parcel currently counts against its destination Node's
  // capacity (nodes.destinationHeldCount). Managed only by handoffs'
  // DestinationCapacitySubscriber.
  @Column({ type: 'boolean', default: false })
  destinationSlotHeld!: boolean;

  // Proof of delivery (plan §5.4): when, how (code | id_check), who
  // collected, and an optional photo taken at the counter.
  @Column({ type: 'timestamptz', nullable: true })
  collectedAt!: Date | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  collectionMethod!: 'code' | 'id_check' | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  collectorName!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  collectionPhotoPublicId!: string | null;

  @Column({ type: 'smallint', default: 0 })
  idCheckFailedAttempts!: number;

  // Why it was turned away at drop-off.
  @Column({ type: 'jsonb', nullable: true })
  refusal!: {
    reason: string;
    note: string | null;
    photoPublicId: string | null;
    at: string;
  } | null;

  // Lost / damaged in our custody.
  @Column({ type: 'jsonb', nullable: true })
  exception!: {
    type: 'lost' | 'damaged';
    note: string;
    at: string;
    byUserId: string;
    previousStatus: string;
  } | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
