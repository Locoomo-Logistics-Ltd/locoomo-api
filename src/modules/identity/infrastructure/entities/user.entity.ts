import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '../../domain/user-role.enum';
import { UserStatus } from '../../domain/user-status.enum';

// email must be lowercased by the caller before insert/query — no DB-level
// case-insensitivity (citext) to avoid an extra Postgres extension for a
// problem application code already has to solve at the DTO boundary.
@Entity('users')
export class UserEntity {
  // gen_random_uuid() is native to Postgres 13+ — deliberately not
  // @PrimaryGeneratedColumn('uuid'), which defaults to uuid_generate_v4()
  // and would require enabling the uuid-ossp extension for no real benefit.
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  email!: string;

  // Null for Admin-provisioned accounts until the user sets one via their
  // invite link (status stays INVITED until then).
  @Column({ type: 'varchar', nullable: true })
  passwordHash!: string | null;

  @Column({ type: 'varchar' })
  firstName!: string;

  @Column({ type: 'varchar' })
  lastName!: string;

  @Column({ type: 'varchar' })
  phone!: string;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.INVITED })
  status!: UserStatus;

  // NDPA — set when the user accepts the ToS/Privacy Policy. Null until then.
  @Column({ type: 'timestamptz', nullable: true })
  consentAcceptedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
