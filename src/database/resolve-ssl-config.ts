import { readFileSync } from 'fs';
import { join } from 'path';
import type { PostgresConnectionCredentialsOptions } from 'typeorm/driver/postgres/PostgresConnectionCredentialsOptions';

// Shared by database.module.ts (running app) and data-source.ts (CLI migrations) —
// both need identical TLS behavior against the same database, so it's one function
// instead of two copies that can silently drift apart.
export function resolveSslConfig(
  caPath: string | undefined,
): PostgresConnectionCredentialsOptions['ssl'] {
  if (!caPath) {
    return undefined;
  }

  const ca = readFileSync(join(process.cwd(), caPath), 'utf8');
  return { ca, rejectUnauthorized: true };
}
