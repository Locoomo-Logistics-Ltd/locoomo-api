import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { InMemorySharedCache, RedisSharedCache } from './shared-cache';

describe('InMemorySharedCache', () => {
  it('returns values until their TTL lapses, and forgets deleted keys', async () => {
    jest.useFakeTimers();
    const cache = new InMemorySharedCache();
    await cache.set('k', { a: 1 }, 10);
    expect(await cache.get('k')).toEqual({ a: 1 });
    jest.advanceTimersByTime(11_000);
    expect(await cache.get('k')).toBeUndefined();

    await cache.set('k2', 1, 10);
    await cache.del('k2');
    expect(await cache.get('k2')).toBeUndefined();
    jest.useRealTimers();
  });

  it('evicts the oldest entry once full', async () => {
    const cache = new InMemorySharedCache(2);
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.set('c', 3, 60);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('c')).toBe(3);
  });
});

// Runs only when a disposable Redis is provided (REDIS_TEST_URL) — CI has
// none, and these must never touch a real/shared instance.
const redisUrl = process.env.REDIS_TEST_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('Redis-backed shared state', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl as string);
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it('counts hits in a fixed window and blocks past the limit', async () => {
    const storage = new RedisThrottlerStorage(redis);
    const key = `t-${Date.now()}`;
    const results: ThrottlerStorageRecord[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(await storage.increment(key, 60_000, 3, 30_000, 'default'));
    }
    expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4]);
    expect(results.slice(0, 3).every((r) => !r.isBlocked)).toBe(true);
    expect(results[3].isBlocked).toBe(true);
    expect(results[3].timeToBlockExpire).toBeGreaterThan(0);

    // While blocked, further hits are not counted.
    const blocked = await storage.increment(key, 60_000, 3, 30_000, 'default');
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.totalHits).toBe(4);
  });

  it('shares cache values across clients, and a delete is visible everywhere', async () => {
    const other = new Redis(redisUrl as string);
    try {
      const a = new RedisSharedCache(redis);
      const b = new RedisSharedCache(other);
      await a.set('member:1', { role: 'owner' }, 30);
      expect(await b.get('member:1')).toEqual({ role: 'owner' });
      await b.del('member:1');
      expect(await a.get('member:1')).toBeUndefined();
    } finally {
      await other.quit();
    }
  });
});
