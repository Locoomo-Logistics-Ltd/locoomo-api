import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { ApiKeyMode } from '../../domain/api-key';
import type { ShipmentEventType } from '../../domain/shipment';

// A shipment's history (GET /shipments/{id}/timeline) and, from M2d, the
// source of its webhooks. Written in the same transaction as the change.
@Entity('merchant_shipment_events')
export class MerchantShipmentEventEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  shipmentId!: string;

  @Column({ type: 'uuid' })
  merchantId!: string;

  @Column({ type: 'varchar' })
  mode!: ApiKeyMode;

  // The shipment's sequence after this change.
  @Column({ type: 'int' })
  sequence!: number;

  @Column({ type: 'varchar', length: 40 })
  type!: ShipmentEventType;

  // Where it happened, when that's meaningful (received at, shelved at…).
  @Column({ type: 'varchar', length: 200, nullable: true })
  nodeName!: string | null;

  // Event-specific extras (fee adjustment, previous destination, …).
  @Column({ type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
