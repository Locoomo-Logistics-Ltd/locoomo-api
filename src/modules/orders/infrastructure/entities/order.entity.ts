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
  @Column({ type: 'uuid' })
  paymentIntentId!: string;

  @Index()
  @Column({ type: 'uuid' })
  consumerId!: string;

  @Column({ type: 'uuid' })
  originNodeId!: string;

  @Column({ type: 'uuid' })
  destinationNodeId!: string;

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
