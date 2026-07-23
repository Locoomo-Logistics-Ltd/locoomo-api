import { AppDataSource } from './data-source';

// Calls TypeORM's programmatic API directly instead of the `typeorm`/
// `typeorm-ts-node-commonjs` CLI (`npm run migration:run`) — that CLI's
// bundled `yargs` dependency resolves to an ESM-only build under some npm
// installs and crashes with ERR_REQUIRE_ESM before it runs anything.
// Intended as the production pre-deploy command (`node dist/database/run-
// migrations.js`); local dev keeps using the CLI-based scripts, which work
// fine there.
async function run(): Promise<void> {
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await AppDataSource.destroy();
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Migration run failed:', error);
    process.exit(1);
  });
