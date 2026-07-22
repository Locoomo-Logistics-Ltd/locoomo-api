import { QueryFailedError } from 'typeorm';

// Postgres error code 23505 = unique_violation. Generic — any module
// inserting into a uniquely-constrained column needs this same translation

export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const code =
    (error as unknown as { code?: string }).code ??
    (error as unknown as { driverError?: { code?: string } }).driverError?.code;

  return code === '23505';
}
