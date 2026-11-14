import { BlockList, isIP } from 'net';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import {
  ApiKeyAuthenticator,
  ApiKeyAuthenticatorRegistry,
} from '../../../common/auth/api-key-authenticator.registry';
import type { ApiKeyPrincipal } from '../../../common/auth/principal';
import { RateLimitedException } from '../../../common/exceptions';
import type { RequestWithCorrelationId } from '../../../common/interceptors/correlation-id.interceptor';
import { SharedCache } from '../../../common/redis/shared-cache';
import {
  ApiKeyKind,
  ApiKeyMode,
  effectiveScopes,
  hashApiKey,
} from '../domain/api-key';
import { MerchantSuspendedException } from '../domain/exceptions/merchant.exceptions';
import { MerchantStatus } from '../domain/merchant.enums';
import { MerchantApiRequestEntity } from '../infrastructure/entities/merchant-api-request.entity';
import { ApiRateLimiter, windowsFor } from './api-rate-limiter';

interface CachedKey {
  id: string;
  merchantId: string;
  merchantStatus: MerchantStatus;
  mode: ApiKeyMode;
  kind: ApiKeyKind;
  scopes: string[];
  allowedIps: string[];
  allowedOrigins: string[];
  hidePrices: boolean;
  expiresAt: string | null;
  revoked: boolean;
}

// Short: revocation busts the entry immediately; merchant status changes
// (suspend, close) reach keys within this window.
const KEY_CACHE_SECONDS = 30;
const TOUCH_EVERY_SECONDS = 60;
const keyCacheKey = (hash: string): string => `api-key:${hash}`;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function clientIp(request: Request): string {
  const ip = request.ip ?? request.socket.remoteAddress ?? '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function ipAllowed(ip: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) {
    return true;
  }
  const family = isIP(ip);
  if (family === 0) {
    return false;
  }
  const list = new BlockList();
  for (const entry of allowList) {
    const [address, bits] = entry.split('/');
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) {
      list.addAddress(address, type);
    } else {
      list.addSubnet(address, Number(bits), type);
    }
  }
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

// Plugs merchant API keys into the global AuthGuard (common can't import
// merchants, so it's registered at startup). Returns null for anything
// that isn't a usable key; the guard turns that into one uniform 401.
@Injectable()
export class ApiKeyAuthenticatorService
  implements ApiKeyAuthenticator, OnModuleInit
{
  private readonly logger = new Logger(ApiKeyAuthenticatorService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: ApiKeyAuthenticatorRegistry,
    private readonly cache: SharedCache,
    private readonly rateLimiter: ApiRateLimiter,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async authenticate(
    rawKey: string,
    request: Request,
  ): Promise<ApiKeyPrincipal | null> {
    const response = request.res as Response;
    const ip = clientIp(request);
    if (await this.cache.get(`api-key-blocked:${ip}`)) {
      response.setHeader('Retry-After', '60');
      throw new RateLimitedException();
    }

    const key = await this.load(hashApiKey(rawKey));
    if (!key || !this.usable(key, ip, request)) {
      if (await this.rateLimiter.failedAttempt(ip)) {
        await this.cache.set(`api-key-blocked:${ip}`, true, 60);
      }
      return null;
    }

    // Suspended (plan §2.1): live reads continue, live writes stop.
    if (
      key.mode === 'live' &&
      key.merchantStatus === MerchantStatus.SUSPENDED &&
      !READ_METHODS.has(request.method)
    ) {
      throw new MerchantSuspendedException();
    }

    const bucket =
      key.kind === 'publishable' ? `key:${key.id}:${ip}` : `key:${key.id}`;
    const limit = await this.rateLimiter.consume(
      bucket,
      windowsFor(key.kind, key.mode),
    );
    ApiRateLimiter.setHeaders(response, limit);
    if (!limit.allowed) {
      throw new RateLimitedException();
    }

    void this.touch(key.id, ip);
    this.logWhenFinished(request, response, key, ip);

    return {
      kind: 'api_key',
      keyId: key.id,
      keyKind: key.kind,
      merchantId: key.merchantId,
      mode: key.mode,
      scopes: effectiveScopes(key.kind, key.scopes),
      hidePrices: key.hidePrices,
    };
  }

  async forget(keyHash: string): Promise<void> {
    await this.cache.del(keyCacheKey(keyHash));
  }

  private usable(key: CachedKey, ip: string, request: Request): boolean {
    if (key.revoked) {
      return false;
    }
    if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
      return false;
    }
    const status = key.merchantStatus;
    if (
      status === MerchantStatus.CLOSED ||
      status === MerchantStatus.REJECTED
    ) {
      return false;
    }
    if (
      key.mode === 'live' &&
      status !== MerchantStatus.APPROVED &&
      status !== MerchantStatus.SUSPENDED
    ) {
      return false;
    }
    if (key.kind === 'secret') {
      return ipAllowed(ip, key.allowedIps);
    }
    const origin = request.headers.origin;
    return (
      key.allowedOrigins.length === 0 ||
      typeof origin !== 'string' ||
      key.allowedOrigins.includes(origin)
    );
  }

  private async load(keyHash: string): Promise<CachedKey | null> {
    const cached = await this.cache.get<{ k: CachedKey | null }>(
      keyCacheKey(keyHash),
    );
    if (cached) {
      return cached.k;
    }
    const [row] = await this.dataSource.query<
      (Omit<CachedKey, 'expiresAt' | 'revoked'> & {
        expiresAt: Date | null;
        revokedAt: Date | null;
      })[]
    >(
      `SELECT k.id, k."merchantId", m.status AS "merchantStatus", k.mode, k.kind,
              k.scopes, k."allowedIps", k."allowedOrigins", k."hidePrices",
              k."expiresAt", k."revokedAt"
         FROM api_keys k
         JOIN merchants m ON m.id = k."merchantId"
        WHERE k."keyHash" = $1`,
      [keyHash],
    );
    const key: CachedKey | null = row
      ? {
          id: row.id,
          merchantId: row.merchantId,
          merchantStatus: row.merchantStatus,
          mode: row.mode,
          kind: row.kind,
          scopes: row.scopes,
          allowedIps: row.allowedIps,
          allowedOrigins: row.allowedOrigins,
          hidePrices: row.hidePrices,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          revoked: row.revokedAt !== null,
        }
      : null;
    await this.cache.set(keyCacheKey(keyHash), { k: key }, KEY_CACHE_SECONDS);
    return key;
  }

  // lastUsedAt/IP at most once a minute per key, not on every request.
  private async touch(keyId: string, ip: string): Promise<void> {
    try {
      const marker = `api-key-touch:${keyId}`;
      if (await this.cache.get(marker)) {
        return;
      }
      await this.cache.set(marker, true, TOUCH_EVERY_SECONDS);
      await this.dataSource.query(
        `UPDATE api_keys SET "lastUsedAt" = now(), "lastUsedIp" = $2 WHERE id = $1`,
        [keyId, ip.slice(0, 45) || null],
      );
    } catch (error) {
      this.logger.warn(`Couldn't record key use: ${String(error)}`);
    }
  }

  private logWhenFinished(
    request: Request,
    response: Response,
    key: CachedKey,
    ip: string,
  ): void {
    const startedAt = Date.now();
    response.once('finish', () => {
      this.dataSource
        .getRepository(MerchantApiRequestEntity)
        .insert({
          merchantId: key.merchantId,
          apiKeyId: key.id,
          mode: key.mode,
          method: request.method.slice(0, 10),
          path: request.originalUrl.split('?')[0].slice(0, 300),
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          ip: ip.slice(0, 45) || null,
          correlationId:
            (request as RequestWithCorrelationId).correlationId?.slice(0, 64) ??
            null,
        })
        .catch((error: unknown) =>
          this.logger.warn(`Couldn't log API request: ${String(error)}`),
        );
    });
  }
}
