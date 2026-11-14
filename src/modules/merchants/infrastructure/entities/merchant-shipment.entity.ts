import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';
import type {
  ExceptionType,
  FeeState,
  NotifyReceiver,
  ReturnReason,
  ShipmentStatus,
} from '../../domain/shipment';

export interface ShipmentNodeSnapshot {
  nodeId: string | null;
  nodeName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}

export interface ShipmentParcel {
  description: string;
  size: string;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  handling: string[];
  declaredValueKobo: number | null;
}

export interface ShipmentFeeBreakdown {
  baseKobo: number;
  distanceKobo: number;
  volumeDiscountKobo: number;
  vatKobo: number;
}

// The merchant-facing record of one parcel (plan §6.1). A live shipment
// will link to one `orders` row (M4); a test shipment is simulated here and
// never creates an order or touches a real Node. Node details are
// snapshots, so reads never call other modules.
@Entity('merchant_shipments')
export class MerchantShipmentEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar', length: 64 })
  reference!: string;

  @Column({ type: 'varchar', length: 20, unique: true })
  trackingCode!: string;

  @Column({ type: 'varchar' })
  status!: ShipmentStatus;

  // +1 on every change; webhooks carry it so integrators can drop
  // out-of-order deliveries.
  @Column({ type: 'int', default: 1 })
  sequence!: number;

  @Column({ type: 'timestamptz' })
  statusChangedAt!: Date;

  @Column({ type: 'varchar' })
  originType!: 'hub' | 'node';

  @Column({ type: 'jsonb' })
  origin!: ShipmentNodeSnapshot;

  @Column({ type: 'jsonb' })
  destination!: ShipmentNodeSnapshot;

  @Column({ type: 'boolean', default: false })
  destinationChanged!: boolean;

  @Column({ type: 'varchar', length: 100 })
  receiverName!: string;

  // E.164.
  @Column({ type: 'varchar', length: 20 })
  receiverPhone!: string;

  @Column({ type: 'varchar', length: 254, nullable: true })
  receiverEmail!: string | null;

  @Column({ type: 'jsonb' })
  parcel!: ShipmentParcel;

  // What we measured at drop-off, when it differed.
  @Column({ type: 'jsonb', nullable: true })
  measured!: { weightKg: number | null; size: string } | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  externalBarcode!: string | null;

  @Column({ type: 'uuid', nullable: true })
  manifestId!: string | null;

  @Column({ type: 'int' })
  quotedKobo!: number;

  @Column({ type: 'int', nullable: true })
  chargedKobo!: number | null;

  @Column({ type: 'varchar' })
  feeState!: FeeState;

  @Column({ type: 'jsonb' })
  feeBreakdown!: ShipmentFeeBreakdown;

  @Column({ type: 'varchar', length: 40 })
  vehicleClass!: string;

  @Column({ type: 'timestamptz' })
  dropDeadline!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  collectionDeadline!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  collectedAt!: Date | null;

  @Column({ type: 'varchar', nullable: true })
  collectionMethod!: 'code' | 'id_check' | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  collectorName!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  returnInfo!: {
    reason: ReturnReason;
    readyForCollectionAt: string | null;
  } | null;

  @Column({ type: 'jsonb', nullable: true })
  exceptionInfo!: {
    type: ExceptionType;
    reportedAt: string;
    claimId: string | null;
  } | null;

  @Column({ type: 'varchar' })
  notifyReceiver!: NotifyReceiver;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, string>;

  // Live shipments only (M4): the physical parcel's order.
  @Column({ type: 'uuid', nullable: true })
  orderId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByKeyId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
