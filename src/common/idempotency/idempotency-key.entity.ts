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
//
// Two kinds of row share the table:
//  - "seen" markers (IdempotencyService.withIdempotency): scope+key only,
//    kept forever, the response columns stay null.
//  - HTTP Idempotency-Key replays (IdempotencyInterceptor): also store a
//    hash of the request and the response it produced, and expire after
//    24h (expiresAt). responseStatus null = still being processed.
@Entity('idempotency_keys')
@Index(['scope', 'key'], { unique: true })
export class IdempotencyKeyEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  scope!: string;

  @Column({ type: 'varchar' })
  key!: string;

  // sha256 of method + route + body — the same key with a different
  // request is a client bug and is rejected, never silently replayed.
  @Column({ type: 'varchar', nullable: true })
  requestHash!: string | null;

  @Column({ type: 'int', nullable: true })
  responseStatus!: number | null;

  // The handler's return value (pre-envelope); replays are re-enveloped so
  // they carry a fresh correlation id.
  @Column({ type: 'jsonb', nullable: true })
  responseBody!: unknown;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
