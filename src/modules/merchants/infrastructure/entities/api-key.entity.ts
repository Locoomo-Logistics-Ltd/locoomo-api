import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ApiKeyKind, ApiKeyMode } from '../../domain/api-key';

// Merchant API key (plan §3.2). Only the SHA-256 hash is stored; the raw
// key is shown once at creation. `prefix` + `last4` identify it on screen.
@Entity('api_keys')
@Index(['merchantId', 'mode'])
export class ApiKeyEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar' })
  kind!: ApiKeyKind;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  // sk_live_ / pk_test_ …
  @Column({ type: 'varchar', length: 8 })
  prefix!: string;

  @Column({ type: 'varchar', length: 4 })
  last4!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  keyHash!: string;

  // Secret keys only (publishable keys are fixed to nodes/quotes).
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  scopes!: string[];

  // Secret keys: optional CIDR allow-list (empty = any IP).
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  allowedIps!: string[];

  // Publishable keys: optional browser-origin allow-list (empty = any).
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  allowedOrigins!: string[];

  // Publishable keys: quotes come back without amounts.
  @Column({ type: 'boolean', default: false })
  hidePrices!: boolean;

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  lastUsedIp!: string | null;

  // Set by a roll: the old key keeps working until then.
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  revokedByUserId!: string | null;

  // The key this one replaced (roll).
  @Column({ type: 'uuid', nullable: true })
  rolledFromKeyId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
