import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NodeMembershipRole } from '../../domain/node-membership-role.enum';

// userId/nodeId are plain columns, not TypeORM relations — NodeEntity and
// UserEntity belong to other modules, and a `@ManyToOne` relation would
// require importing their entity classes, which the module-boundary rule
// forbids. Real FK constraints to users(id)/nodes(id) still exist at the DB
// level (see the migration) for referential integrity; cross-module reads
// (e.g. the Admin pending-review queue) go through a raw SQL join instead of
// a TypeORM relation, the same reasoning nodes.service.ts already applies to
// its own proximity query.
//
// One row per (userId, nodeId) pair — a user can have a membership at
// several Nodes (one operator running multiple locations), and a Node can
// have several members (one owner plus any number of staff, Phase 2).
// roleAtNode is what actually gates capability, not which endpoint created
// the row.
@Entity('node_memberships')
@Index(['userId', 'nodeId'], { unique: true })
export class NodeMembershipEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid' })
  nodeId!: string;

  @Column({
    type: 'enum',
    enum: NodeMembershipRole,
    default: NodeMembershipRole.OWNER,
  })
  roleAtNode!: NodeMembershipRole;

  // Payout bank account — deliberately kept per-membership-row rather than
  // extracted to an owner-level entity: a franchise-style owner may
  // genuinely want a different payout account per location, and this is
  // already the right granularity for that. Only ever set on an OWNER row
  // in practice (SetNodePayoutAccountService requires it) — staff rows just
  // carry nulls here, same all-or-nothing shape as RiderProfileEntity's.
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
