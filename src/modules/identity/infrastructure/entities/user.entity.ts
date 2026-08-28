import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '../../../../common/auth/user-role.enum';
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

  // Nullable — no longer collected at registration (neither password nor
  // Google signup can reliably obtain it there; see google-auth.service.ts).
  // Set later via PATCH /users/me. Null is a real, expected, long-lived
  // state, not a transient one — GET /users/me exposes it as-is so the
  // frontend can nudge for it; Rider/NodeOperator onboarding hard-gates on
  // it (see UserLookupService.getPhone).
  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  // Google's `sub` claim — set only for accounts created via Google
  // sign-in. Unique so a Google identity can only ever back one account;
  // deliberately a plain nullable column on UserEntity, not a separate
  // identities table — same reasoning passwordHash is nullable here rather
  // than living in its own table. Promote to a join table only if a second
  // OAuth provider becomes a real requirement.
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  googleId!: string | null;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.INVITED })
  status!: UserStatus;

  // NDPA — set when the user accepts the ToS/Privacy Policy. Null until then.
  @Column({ type: 'timestamptz', nullable: true })
  consentAcceptedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  // Reset to 0 on any successful login. Incremented on a wrong password;
  // crossing the threshold sets lockedUntil
  @Column({ type: 'int', default: 0 })
  failedLoginAttempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
