import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// Nigerian public holidays (admin-managed): they don't count as working
// days for collection windows and reminders (plan §5.5). Federal holidays
// are often announced late, so ops adds them as they're declared.
@Entity('public_holidays')
export class PublicHolidayEntity {
  // Lagos calendar date, "YYYY-MM-DD".
  @PrimaryColumn({ type: 'date' })
  date!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
