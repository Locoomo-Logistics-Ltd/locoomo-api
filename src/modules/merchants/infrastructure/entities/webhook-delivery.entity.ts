import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type WebhookDeliveryStatus =
  'pending' | 'delivering' | 'succeeded' | 'failed';

// One event to one endpoint, with its latest attempt (the delivery log).
@Entity('webhook_deliveries')
export class WebhookDeliveryEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar', length: 40 })
  eventId!: string;

  @Column({ type: 'uuid' })
  endpointId!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  status!: WebhookDeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz' })
  nextAttemptAt!: Date;

  // A worker's claim; another may take it over after this.
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ type: 'smallint', nullable: true })
  responseStatus!: number | null;

  @Column({ type: 'text', nullable: true })
  responseBody!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @Column({ type: 'int', nullable: true })
  durationMs!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
