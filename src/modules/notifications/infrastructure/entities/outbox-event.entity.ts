import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OutboxEventStatus } from '../../domain/outbox-event-status.enum';

// Generic across the whole app, not identity-specific — any module writes a
// row here  to get a best-effort-but-must-eventually-happen side
// effect delivered. `eventType` is what the poller dispatches on; `payload`
// is whatever shape that type needs (for 'email', an EmailMessage).
@Entity('outbox_events')
export class OutboxEventEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Index()
  @Column({
    type: 'enum',
    enum: OutboxEventStatus,
    default: OutboxEventStatus.PENDING,
  })
  status!: OutboxEventStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', nullable: true })
  lastError!: string | null;

  // Poller only picks up rows due now or in the past — lets backoff push a
  // retry into the future without a separate "delayed" status.
  @Index()
  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
