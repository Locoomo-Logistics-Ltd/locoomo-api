import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';

// Where a merchant receives events (MERCHANT_API.md §12). The signing
// secret must be readable to sign, so it's encrypted (SecretBox
// 'webhook-secret'), never hashed.
@Entity('webhook_endpoints')
@Index(['merchantId', 'mode'])
export class WebhookEndpointEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description!: string | null;

  // Subscribed event types; empty = all.
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  events!: string[];

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'varchar', length: 300, nullable: true })
  disabledReason!: string | null;

  @Column({ type: 'text' })
  secretSealed!: string;

  // After a roll, the old secret signs too until this time.
  @Column({ type: 'text', nullable: true })
  previousSecretSealed!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  previousSecretExpiresAt!: Date | null;

  // First failure since the last success; disables the endpoint after 36h.
  @Column({ type: 'timestamptz', nullable: true })
  failingSince!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
