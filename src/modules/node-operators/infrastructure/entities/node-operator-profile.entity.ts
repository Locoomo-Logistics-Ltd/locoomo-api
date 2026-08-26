import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

// userId/nodeId are plain columns, not TypeORM relations — NodeEntity and
// UserEntity belong to other modules, and a `@ManyToOne` relation would
// require importing their entity classes, which the module-boundary rule
// forbids. Real FK constraints to users(id)/nodes(id) still exist at the DB
// level (see the migration) for referential integrity; cross-module reads
// (e.g. the Admin pending-review queue) go through a raw SQL join instead of
// a TypeORM relation, the same reasoning nodes.service.ts already applies to
// its own proximity query.
@Entity('node_operator_profiles')
export class NodeOperatorProfileEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  // One Node per operator, MVP (PRD: "NodeOperator tied to exactly one
  // Node") — enforced here via a unique index, not just an application
  // check.
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  // Deliberately not unique — Node stays naturally one-to-many with
  // operators at the DB level so relaxing "one active operator per Node"
  // for E14 later is an application-rule change, not a migration.
  @Column({ type: 'uuid' })
  nodeId!: string;

  // Payout bank account for this Node — same all-or-nothing shape as
  // RiderProfileEntity's payout fields (see that entity's comment).
  // Node itself has no login/session, so its payout account is owned by
  // whichever operator profile manages it (MVP one-operator-per-node, same
  // assumption everything else here already makes).
  @Column({ type: 'varchar', nullable: true })
  payoutBankCode!: string | null;

  @Column({ type: 'varchar', nullable: true })
  payoutBankName!: string | null;

  @Column({ type: 'varchar', nullable: true })
  payoutAccountNumber!: string | null;

  @Column({ type: 'varchar', nullable: true })
  payoutAccountName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  payoutAccountVerifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
