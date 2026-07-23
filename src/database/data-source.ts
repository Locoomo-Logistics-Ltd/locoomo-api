import 'dotenv/config';
import { DataSource } from 'typeorm';
import { resolveSslConfig } from './resolve-ssl-config';

// Standalone DataSource for migrations (CLI locally, run-migrations.ts in
// prod). The running app uses database.module.ts instead — this file never
// backs the live server.
//
// Loaded two ways with two different file layouts on disk: ts-node running
// this .ts file directly against src/ (local CLI), or plain node running the
// compiled .js in dist/ (production, see run-migrations.ts) — hence the glob
// switch below instead of one hardcoded path.
const isCompiled = __filename.endsWith('.js');

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: resolveSslConfig(process.env.DATABASE_SSL_CA_PATH),
  entities: [isCompiled ? 'dist/**/*.entity.js' : 'src/**/*.entity.ts'],
  migrations: [
    isCompiled
      ? 'dist/database/migrations/*.js'
      : 'src/database/migrations/*.ts',
  ],
  synchronize: false,
});
