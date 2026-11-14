import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import type { Response } from 'express';
import { from, lastValueFrom, Observable } from 'rxjs';
import { DataSource } from 'typeorm';
import type { RequestWithUser } from '../auth/auth.guard';
import { isUniqueViolation } from '../database/is-unique-violation.util';
import { IdempotencyKeyEntity } from './idempotency-key.entity';
import {
  IdempotencyInProgressException,
  IdempotencyKeyReusedException,
  InvalidIdempotencyKeyException,
} from './idempotency.exceptions';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// A reservation with no stored response after this long belongs to a
// request whose process died mid-handler — reclaimable, so the client
// isn't locked out of its own key for the full 24h.
export const IDEMPOTENCY_IN_PROGRESS_LEASE_MS = 5 * 60 * 1000;

const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

// Opt-in per route with @UseInterceptors(IdempotencyInterceptor) (the
// module must import IdempotencyModule). When the request carries an
// Idempotency-Key header:
//  - first time: the key is reserved, the handler runs, and its status +
//    return value are stored for 24h;
//  - same key + same request again: the stored response is replayed (the
//    handler does NOT run again) with `Idempotent-Replayed: true`;
//  - same key + different request: 422 IDEMPOTENCY_KEY_REUSED;
//  - same key while the first is still running: 409 IDEMPOTENCY_IN_PROGRESS;
//  - the handler failed: the reservation is released so the client can
//    retry with the same key (errors aren't cached).
// No header → the request is processed normally (header is optional).
//
// Keys are scoped per caller (API key's merchant + mode, or user), so two
// merchants can never collide on the same key string.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const response = http.getResponse<Response>();

    const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (rawKey === undefined) {
      return next.handle();
    }
    if (typeof rawKey !== 'string' || !KEY_PATTERN.test(rawKey)) {
      throw new InvalidIdempotencyKeyException();
    }

    const scope = idempotencyScope(request);
    const requestHash = hashRequest(request);
    const successStatus =
      this.reflector.get<number | undefined>(
        HTTP_CODE_METADATA,
        context.getHandler(),
      ) ?? (request.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    return from(
      this.run(scope, rawKey, requestHash, successStatus, response, next),
    );
  }

  private async run(
    scope: string,
    key: string,
    requestHash: string,
    successStatus: number,
    response: Response,
    next: CallHandler,
  ): Promise<unknown> {
    const repo = this.dataSource.getRepository(IdempotencyKeyEntity);

    // Reclaim this key if it expired, or if its reservation was abandoned
    // by a crashed request (in progress for longer than the lease).
    await repo
      .createQueryBuilder()
      .delete()
      .where('scope = :scope AND key = :key', { scope, key })
      .andWhere(
        `("expiresAt" <= now() OR ("responseStatus" IS NULL AND "createdAt" <= now() - (:leaseMs * interval '1 millisecond')))`,
        { leaseMs: IDEMPOTENCY_IN_PROGRESS_LEASE_MS },
      )
      .execute();

    try {
      await repo.insert({
        scope,
        key,
        requestHash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await repo.findOneByOrFail({ scope, key });
      if (existing.requestHash !== requestHash) {
        throw new IdempotencyKeyReusedException();
      }
      if (existing.responseStatus === null) {
        throw new IdempotencyInProgressException();
      }
      response.status(existing.responseStatus);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return existing.responseBody;
    }

    let body: unknown;
    try {
      body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    } catch (error) {
      await repo.delete({ scope, key });
      throw error;
    }

    await this.dataSource.query(
      `UPDATE idempotency_keys
          SET "responseStatus" = $1, "responseBody" = $2::jsonb
        WHERE scope = $3 AND key = $4`,
      [successStatus, JSON.stringify(body ?? null), scope, key],
    );
    return body;
  }
}

export function idempotencyScope(request: RequestWithUser): string {
  const principal = request.principal;
  if (principal?.kind === 'api_key') {
    return `http:merchant:${principal.merchantId}:${principal.mode}`;
  }
  if (principal?.kind === 'user') {
    return `http:user:${principal.userId}`;
  }
  // Public route: scope by IP so anonymous callers can't collide with — or
  // read — each other's stored responses through a guessed key.
  return `http:anon:${request.ip ?? 'unknown'}`;
}

function hashRequest(request: RequestWithUser): string {
  const route =
    (request.route as { path?: string } | undefined)?.path ?? request.path;
  return createHash('sha256')
    .update(request.method)
    .update('\n')
    .update(`${request.baseUrl}${route}`)
    .update('\n')
    .update(request.originalUrl)
    .update('\n')
    .update(stableStringify(request.body))
    .digest('hex');
}

// Key-order-insensitive JSON, so {"a":1,"b":2} and {"b":2,"a":1} — the same
// request from the client's point of view — hash identically.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
