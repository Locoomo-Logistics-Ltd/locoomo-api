import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

// Routing configuration for one courier — the business-tunable half of a
// provider (whether it's on, its preference order, where it may operate).
// The code-declared half (capabilities) lives on the adapter. Secrets live
// in env, never here.
@Entity('logistics_providers')
export class LogisticsProviderConfigEntity {
  // Matches LogisticsProvider.key on the adapter.
  @PrimaryColumn({ type: 'varchar' })
  key!: string;

  @Column({ type: 'varchar' })
  label!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  // Lower = tried first. In-house riders sit last as the fallback.
  @Column({ type: 'int' })
  priority!: number;

  // How many legs one order may use with this provider before moving on.
  @Column({ type: 'int', default: 1 })
  maxAttempts!: number;

  // Give up on a requested-but-unassigned leg after this long and move on.
  // Null = wait indefinitely (in-house pool).
  @Column({ type: 'int', nullable: true })
  assignTimeoutMinutes!: number | null;

  // Straight-line Node-to-Node distance limits; null = unlimited.
  @Column({ type: 'double precision', nullable: true })
  minDistanceKm!: number | null;

  @Column({ type: 'double precision', nullable: true })
  maxDistanceKm!: number | null;

  // When set, only orders from these origin Nodes may use this provider —
  // for pilots.
  @Column({ type: 'uuid', array: true, nullable: true })
  pilotNodeIds!: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
