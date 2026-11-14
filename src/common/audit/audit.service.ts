import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { EntityManager, Repository } from 'typeorm';
import type { RequestWithUser } from '../auth/auth.guard';
import type { RequestWithCorrelationId } from '../interceptors/correlation-id.interceptor';
import { AuditActorType, AuditEventEntity } from './audit-event.entity';
import { redact } from './redact';

export interface AuditActor {
  type: AuditActorType;
  id: string | null;
  role?: string | null;
}

export interface AuditRequestContext {
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  merchantId?: string | null;
  target?: { type: string; id: string };
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  context?: AuditRequestContext;
}

export const SYSTEM_ACTOR: AuditActor = { type: 'system', id: null };

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly events: Repository<AuditEventEntity>,
  ) {}

  // Pass the caller's EntityManager whenever the audited change happens in
  // a transaction — the audit row then commits (or rolls back) with it, so
  // the log can never claim something happened that didn't, or miss
  // something that did.
  async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    const repo = manager
      ? manager.getRepository(AuditEventEntity)
      : this.events;

    await repo.save(
      repo.create({
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        actorRole: entry.actor.role ?? null,
        merchantId: entry.merchantId ?? null,
        action: entry.action,
        targetType: entry.target?.type ?? null,
        targetId: entry.target?.id ?? null,
        before: entry.before ? redact(entry.before) : null,
        after: entry.after ? redact(entry.after) : null,
        metadata: entry.metadata ? redact(entry.metadata) : null,
        ip: entry.context?.ip ?? null,
        userAgent: entry.context?.userAgent?.slice(0, 500) ?? null,
        correlationId: entry.context?.correlationId ?? null,
      }),
    );
  }
}

export function auditContextFrom(request: Request): AuditRequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    correlationId: (request as RequestWithCorrelationId).correlationId ?? null,
  };
}

export function auditActorFrom(request: Request): AuditActor {
  const principal = (request as RequestWithUser).principal;
  if (!principal) {
    return SYSTEM_ACTOR;
  }
  return principal.kind === 'user'
    ? { type: 'user', id: principal.userId, role: principal.role }
    : { type: 'api_key', id: principal.keyId, role: null };
}
