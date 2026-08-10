import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// Generic across the whole app (decision #5) — any module that needs to make
// a scan/confirm/webhook endpoint idempotent inserts one row here inside its
// own transaction. `scope` namespaces the key so two unrelated flows can
// never collide on the same string (e.g. a Paystack transaction reference
// vs. a client-supplied Idempotency-Key header).
@Entity('idempotency_keys')
@Index(['scope', 'key'], { unique: true })
export class IdempotencyKeyEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  scope!: string;

  @Column({ type: 'varchar' })
  key!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
