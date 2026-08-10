import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NodeOnboardingType } from '../../domain/node-onboarding-type.enum';
import { NodeStatus } from '../../domain/node-status.enum';

// The `location` geography(Point,4326) column (+ GiST index) is created by
// migration 1784900000000-CreateNodes but deliberately has no TS-mapped
// field here — it's written/read only via raw SQL in NodesService, so
// nothing depends on TypeORM's spatial column (de)serialization behavior.
// latitude/longitude are the source of truth for plain reads/writes;
// `location` exists purely to give the proximity query a real spatial index.
@Entity('nodes')
export class NodeEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar' })
  address!: string;

  @Column({ type: 'varchar' })
  city!: string;

  @Column({ type: 'varchar' })
  state!: string;

  @Column({ type: 'varchar', default: 'Nigeria' })
  country!: string;

  @Column({ type: 'double precision' })
  latitude!: number;

  @Column({ type: 'double precision' })
  longitude!: number;

  // Self-reported by the operator (or set by Admin on manual create) — max
  // parcels this Node can hold at once.
  @Column({ type: 'int' })
  capacity!: number;

  // Atomic counter per decision #6 — incremented under SELECT...FOR UPDATE
  // at PaymentIntent/DRAFT creation (NodesService.reserveCapacitySlot),
  // decremented on failure/expiry/cancellation (releaseCapacitySlot). Only
  // ever touched via those two methods, never a plain repo.save. Currently
  // only tracks origin-side drop-off holds — release-on-parcel-departure
  // (freeing the slot once a rider actually takes the parcel) is `handoffs`'
  // job once that module exists; until then a completed order's slot stays
  // held, which is correct (the parcel is still physically at the Node).
  @Column({ type: 'int', default: 0 })
  currentCount!: number;

  @Index()
  @Column({ type: 'enum', enum: NodeStatus, default: NodeStatus.PENDING })
  status!: NodeStatus;

  @Column({ type: 'enum', enum: NodeOnboardingType })
  onboardingType!: NodeOnboardingType;

  @Column({ type: 'varchar', nullable: true })
  operatingHours!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
