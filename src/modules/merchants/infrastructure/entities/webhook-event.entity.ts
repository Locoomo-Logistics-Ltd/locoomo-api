import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';

// One event, exactly as it is sent (the JSON body). Kept 30 days for
// retries and replays.
@Entity('webhook_events')
@Index(['merchantId', 'mode', 'createdAt'])
export class WebhookEventEntity {
  // "msg_…": the webhook-id header and the body's `id`.
  @PrimaryColumn('varchar', { length: 40 })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar', length: 60 })
  type!: string;

  // The exact body we send (serialised once, signed per attempt).
  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
