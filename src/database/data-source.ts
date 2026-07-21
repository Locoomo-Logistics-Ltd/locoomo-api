import 'dotenv/config';
import { DataSource } from 'typeorm';

// Standalone DataSource for the TypeORM CLI (migration run/generate/revert).
// The running app uses database.module.ts instead — this file is CLI-only.
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
});
