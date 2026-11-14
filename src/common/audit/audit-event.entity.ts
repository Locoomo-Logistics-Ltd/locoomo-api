import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export type AuditActorType = 'user' | 'api_key' | 'system';

// Append-only record of who did what to what — every admin action and every
// sensitive merchant action (keys, webhooks, bank account, roles, money).
// Never updated or deleted by application code. before/after are redacted
// by AuditService before they get here (secrets and personal data never
// land in this table).
@Entity('audit_events')
@Index(['targetType', 'targetId', 'createdAt'])
@Index(['actorId', 'createdAt'])
@Index(['merchantId', 'createdAt'])
@Index(['action', 'createdAt'])
export class AuditEventEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  actorType!: AuditActorType;

  // users.id for 'user', api_keys.id for 'api_key', null for 'system'.
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  // The actor's role at the time (admin, consumer, …) — kept because roles
  // and admin permissions change later.
  @Column({ type: 'varchar', nullable: true })
  actorRole!: string | null;

  // Scopes the event to a merchant so its own team can read its audit log.
  @Column({ type: 'uuid', nullable: true })
  merchantId!: string | null;

  // Dotted verb, e.g. 'merchant.approved', 'api_key.revoked',
  // 'wallet.adjustment.approved', 'admin.permissions.updated'.
  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'varchar', nullable: true })
  targetType!: string | null;

  @Column({ type: 'varchar', nullable: true })
  targetId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after!: Record<string, unknown> | null;

  // Free-form context: reason, approval request id, etc.
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'varchar', nullable: true })
  correlationId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
