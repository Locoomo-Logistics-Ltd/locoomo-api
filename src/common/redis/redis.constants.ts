// Injection token for the shared ioredis client — `Redis | null`. Null means
// REDIS_URL isn't configured and callers must fall back to per-process state
// (correct only while one instance runs; see env.validation.ts REDIS_URL).
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
