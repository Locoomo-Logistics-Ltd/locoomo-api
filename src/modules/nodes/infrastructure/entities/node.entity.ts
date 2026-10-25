import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { OpeningHours } from '../../../../common/opening-hours/opening-hours';
import { NodeLocationCheck } from '../../domain/node-location-check';
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

  // Legacy free-text hours — superseded by openingHours, kept readable until
  // every client has switched over.
  @Column({ type: 'varchar', nullable: true })
  operatingHours!: string | null;

  // Structured weekly hours (common/opening-hours) — machine-checkable, so
  // dispatch can tell whether a Node will be open when a courier arrives.
  // Required for new Nodes; NULL only on Nodes created before it existed.
  @Column({ type: 'jsonb', nullable: true })
  openingHours!: OpeningHours | null;

  // Counter phone couriers call on arrival, E.164. Required for new Nodes;
  // backfilled from the owner's phone for existing ones.
  @Column({ type: 'varchar', nullable: true })
  contactPhone!: string | null;

  // Result of checking the map pin against the address (see
  // NodeLocationVerifierService). Plain varchar, not a Postgres enum, so a
  // new outcome doesn't need an ALTER TYPE. NULL = never checked.
  @Column({ type: 'varchar', nullable: true })
  locationCheck!: NodeLocationCheck | null;

  @Column({ type: 'timestamptz', nullable: true })
  locationCheckedAt!: Date | null;

  // Owner-toggled (NodeOperatorsModule's SetNodeVisibilityService) — false
  // excludes the Node from GET /nodes and GET /nodes/nearby for non-Admin
  // callers, and from being targeted by a Consumer-initiated PaymentIntent
  // (CreatePaymentIntentService), for a Node that only wants to dispatch its
  // own parcels through the network, not accept public drop-offs.
  @Column({ type: 'boolean', default: true })
  isPubliclyVisible!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
