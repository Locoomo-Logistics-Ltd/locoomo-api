import { z } from 'zod';

// Grows as each module is added — don't pre-declare vars nothing reads yet.
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  // generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  JWT_ACCESS_SECRET: z.string().min(32),
  // Path to the DB provider's CA cert, repo-relative. Unset locally (docker-compose Postgres has no TLS) - required against Supabase/Neon so the connection verifies
  DATABASE_SSL_CA_PATH: z.string().optional(),
  // domain, e.g. app.locoomo.com + api.locoomo.com) for SameSite=Strict cookies to be sent at all; a genuinely cross-site frontend breaks login.
  CORS_ORIGIN: z.string().min(1),
  // rontend origin used to build links embedded in emails
  // (password reset, email verification, invite)
  FRONTEND_URL: z.url(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  // "From" header — either a bare address or "Name <address>".
  SMTP_FROM: z.string().min(1),
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
