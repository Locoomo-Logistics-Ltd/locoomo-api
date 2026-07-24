import { hashPassword } from '../modules/identity/domain/password-hasher';
import { UserRole } from '../modules/identity/domain/user-role.enum';
import { UserStatus } from '../modules/identity/domain/user-status.enum';
import { UserEntity } from '../modules/identity/infrastructure/entities/user.entity';
import { AppDataSource } from './data-source';

// One-off, idempotent bootstrap for the very first Admin account.
// admin-invite (POST /users/invite) itself requires an existing Admin, so
// nothing else in the app can create the first one — this is the deliberate
// out-of-band escape hatch. Run once per environment:
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:admin
async function seed(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const firstName = process.env.ADMIN_FIRST_NAME ?? 'Admin';
  const lastName = process.env.ADMIN_LAST_NAME ?? 'User';
  const phone = process.env.ADMIN_PHONE ?? '+2340000000000';

  if (!email || !password) {
    throw new Error(
      'seed:admin requires ADMIN_EMAIL and ADMIN_PASSWORD environment variables',
    );
  }
  if (password.length < 12) {
    throw new Error(
      'ADMIN_PASSWORD must be at least 12 characters — same policy as every other account',
    );
  }

  await AppDataSource.initialize();

  try {
    const users = AppDataSource.getRepository(UserEntity);
    const existing = await users.findOneBy({ email });

    if (existing) {
      console.log(`Admin account already exists for ${email} — nothing to do.`);
      return;
    }

    const passwordHash = await hashPassword(password);
    await users.save(
      users.create({
        email,
        passwordHash,
        firstName,
        lastName,
        phone,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
        emailVerifiedAt: new Date(),
      }),
    );

    console.log(`Admin account created for ${email}.`);
  } finally {
    await AppDataSource.destroy();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('seed:admin failed:', error);
    process.exit(1);
  });
