import { z } from 'zod';

// Grows as each module is added — don't pre-declare vars nothing reads yet.
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  // HMAC signing key for access tokens. 32 bytes hex (64 chars) minimum —
  // generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  JWT_ACCESS_SECRET: z.string().min(32),
  // Path to the DB provider's CA cert, repo-relative. Unset locally (docker-compose
  // Postgres has no TLS) — required against Supabase/Neon so the connection verifies
  // the server cert instead of falling back to sslmode's weaker unverified modes.
  DATABASE_SSL_CA_PATH: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
