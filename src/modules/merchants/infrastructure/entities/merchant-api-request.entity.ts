import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';

// One row per API-key request, for the dashboard's API logs and support.
// Metadata only — never bodies (they hold receiver PII). Kept 30 days.
@Entity('merchant_api_requests')
export class MerchantApiRequestEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'uuid' })
  apiKeyId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  @Column({ type: 'varchar', length: 10 })
  method!: string;

  // Path without the query string.
  @Column({ type: 'varchar', length: 300 })
  path!: string;

  @Column({ type: 'smallint' })
  statusCode!: number;

  @Column({ type: 'int' })
  durationMs!: number;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  correlationId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
