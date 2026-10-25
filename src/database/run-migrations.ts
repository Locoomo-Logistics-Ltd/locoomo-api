import { AppDataSource } from './data-source';

// Arbitrary but fixed: every instance of this app contends for the same
// Postgres advisory lock while migrating.
const MIGRATION_LOCK_KEY = 4_761_982_303;

// Runs pending migrations; the container does this before starting the app
// (see Dockerfile CMD). Calls TypeORM's programmatic API directly instead of
// the `typeorm`/`typeorm-ts-node-commonjs` CLI (`npm run migration:run`) —
// that CLI's bundled `yargs` dependency resolves to an ESM-only build under
// some npm installs and crashes with ERR_REQUIRE_ESM before it runs
// anything. Local dev keeps using the CLI-based scripts, which work there.
//
// Safe when several instances start at once (a multi-replica deploy):
// they queue on a session-level advisory lock, so one migrates and the rest
// then find nothing pending — instead of two applying the same migration
// concurrently.
async function run(): Promise<void> {
  await AppDataSource.initialize();
  const lock = AppDataSource.createQueryRunner();
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const applied = await AppDataSource.runMigrations();
    console.log(
      applied.length > 0
        ? `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`
        : 'No pending migrations',
    );
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    await lock.release();
    await AppDataSource.destroy();
  }
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Migration run failed:', error);
    process.exit(1);
  });
