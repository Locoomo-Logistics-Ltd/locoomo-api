import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { ImportRowStatus } from '../../domain/shipment-import';

// One shipment to create. `input` is the shipment body as received (or as
// mapped from the CSV row); `line` is the CSV line it came from.
@Entity('shipment_import_rows')
export class ShipmentImportRowEntity {
  @PrimaryColumn('uuid')
  importId!: string;

  @PrimaryColumn('int')
  index!: number;

  @Column({ type: 'int', nullable: true })
  line!: number | null;

  @Column({ type: 'varchar', default: 'pending' })
  status!: ImportRowStatus;

  @Column({ type: 'jsonb' })
  input!: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: true })
  shipmentId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  error!: { code: string; message: string; details?: unknown } | null;
}
