import type Redis from 'ioredis';

// Small TTL key/value cache shared by every instance of the API when Redis
// is configured (auth lookups, API-key principals, session denylist).
// Values live only in Redis in that mode — no per-process copy — so a
// `del()` on one instance (key revoked, member removed) is visible to every
// other instance on its very next read. No pub/sub invalidation to get wrong.
export abstract class SharedCache {
  abstract get<T>(key: string): Promise<T | undefined>;
  abstract set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  abstract del(key: string): Promise<void>;
}

const KEY_PREFIX = 'locoomo:cache:';

export class RedisSharedCache extends SharedCache {
  constructor(private readonly redis: Redis) {
    super();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(KEY_PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      KEY_PREFIX + key,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  }

  async del(key: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + key);
  }
}

// Single-instance fallback. Bounded so a flood of distinct keys (e.g. random
// invalid API keys) can't grow memory without limit — oldest entries are
// evicted first (Map preserves insertion order).
export class InMemorySharedCache extends SharedCache {
  private readonly entries = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  constructor(private readonly maxEntries = 10_000) {
    super();
  }

  get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.resolve(undefined);
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest: IteratorResult<string> = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}
