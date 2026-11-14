import { Injectable } from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import type { ApiKeyKind, ApiKeyMode } from '../domain/api-key';

interface Window {
  label: string;
  ttlMs: number;
  limit: number;
}

// MERCHANT_API.md §5.5. Per key (publishable keys: per key per end-user IP,
// since one pk is shared by every browser on the merchant's checkout).
export function windowsFor(kind: ApiKeyKind, mode: ApiKeyMode): Window[] {
  if (kind === 'publishable') {
    return [{ label: 's', ttlMs: 1_000, limit: 30 }];
  }
  return mode === 'live'
    ? [
        { label: 'm', ttlMs: 60_000, limit: 3_000 },
        { label: 's', ttlMs: 1_000, limit: 50 },
      ]
    : [{ label: 's', ttlMs: 1_000, limit: 25 }];
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

const THROTTLER_NAME = 'merchant-api';

// Uses the app's throttler storage (Redis when configured), so limits hold
// across API replicas. Runs after the key is known — the global per-IP
// throttler skips API-key requests (common.module.ts).
@Injectable()
export class ApiRateLimiter {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
  ) {}

  async consume(bucket: string, windows: Window[]): Promise<RateLimitResult> {
    let reported: RateLimitResult | null = null;
    for (const window of windows) {
      const record = await this.storage.increment(
        `${bucket}:${window.label}`,
        window.ttlMs,
        window.limit,
        window.ttlMs,
        THROTTLER_NAME,
      );
      const result: RateLimitResult = {
        allowed: !record.isBlocked,
        limit: window.limit,
        remaining: Math.max(window.limit - record.totalHits, 0),
        resetSeconds: record.timeToExpire,
        retryAfterSeconds: Math.max(
          record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
          1,
        ),
      };
      // Headers describe the first window (the per-minute one for live
      // keys) unless a later one is what blocked.
      if (!result.allowed) {
        return result;
      }
      reported ??= result;
    }
    return reported!;
  }

  // Counts failed key lookups per IP: stops anyone hammering the key table
  // with guesses once the per-IP throttler no longer applies.
  async failedAttempt(ip: string): Promise<boolean> {
    const record = await this.storage.increment(
      `invalid:${ip}`,
      60_000,
      30,
      60_000,
      THROTTLER_NAME,
    );
    return record.isBlocked;
  }

  static setHeaders(response: Response, result: RateLimitResult): void {
    response.setHeader('X-RateLimit-Limit', String(result.limit));
    response.setHeader('X-RateLimit-Remaining', String(result.remaining));
    response.setHeader('X-RateLimit-Reset', String(result.resetSeconds));
    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
    }
  }
}
