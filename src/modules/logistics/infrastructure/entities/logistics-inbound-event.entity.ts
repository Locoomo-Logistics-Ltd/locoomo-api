import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Unique,
} from 'typeorm';

// A courier webhook as received, before processing — deduplicated on the
// provider's own event id, kept as an audit trail, and replayable.
@Entity('logistics_inbound_events')
@Unique('UQ_logistics_inbound_events_event', ['providerKey', 'eventId'])
export class LogisticsInboundEventEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar' })
  providerKey!: string;

  @Column({ type: 'varchar' })
  eventId!: string;

  @Column({ type: 'varchar', nullable: true })
  externalId!: string | null;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
