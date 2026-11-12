import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { SessionDenylist } from '../../../common/auth/session-denylist';
import { EntityNotFoundException } from '../../../common/exceptions';

export interface SessionSummary {
  // The refresh-token family id.
  id: string;
  startedAt: Date;
  lastActiveAt: Date;
  ip: string | null;
  userAgent: string | null;
  // The session making this request.
  current: boolean;
}

// A "session" is one sign-in on one device: a refresh-token family. It's
// active while its newest token is neither revoked nor expired.
@Injectable()
export class SessionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly denylist: SessionDenylist,
    private readonly audit: AuditService,
  ) {}

  async list(
    userId: string,
    currentSessionId: string | undefined,
  ): Promise<SessionSummary[]> {
    const rows = await this.dataSource.query<Omit<SessionSummary, 'current'>[]>(
      `SELECT "familyId" AS id,
              MIN("createdAt") AS "startedAt",
              MAX("createdAt") AS "lastActiveAt",
              (array_agg(ip ORDER BY "createdAt" DESC))[1] AS ip,
              (array_agg("userAgent" ORDER BY "createdAt" DESC))[1] AS "userAgent"
         FROM refresh_tokens
        WHERE "userId" = $1
        GROUP BY "familyId"
       HAVING bool_or("revokedAt" IS NULL AND "expiresAt" > now())
        ORDER BY MAX("createdAt") DESC`,
      [userId],
    );
    return rows.map((row) => ({
      ...row,
      current: row.id === currentSessionId,
    }));
  }

  async revoke(
    userId: string,
    sessionId: string,
    context: AuditRequestContext,
  ): Promise<void> {
    const [, affected] = await this.dataSource.query<[unknown[], number]>(
      `UPDATE refresh_tokens SET "revokedAt" = now()
        WHERE "userId" = $1 AND "familyId" = $2 AND "revokedAt" IS NULL`,
      [userId, sessionId],
    );
    if (affected === 0) {
      throw new EntityNotFoundException('Session', sessionId);
    }
    await this.denylist.revoke([sessionId]);
    await this.audit.record({
      actor: { type: 'user', id: userId },
      action: 'session.revoked',
      target: { type: 'session', id: sessionId },
      context,
    });
  }

  // "Sign out everywhere else" — keeps the caller's own session.
  async revokeOthers(
    userId: string,
    keepSessionId: string | undefined,
    context: AuditRequestContext,
  ): Promise<number> {
    const revoked = await this.revokeAllForUser(
      userId,
      this.dataSource.manager,
      keepSessionId,
    );
    await this.audit.record({
      actor: { type: 'user', id: userId },
      action: 'session.revoked_others',
      target: { type: 'user', id: userId },
      metadata: { count: revoked.length },
      context,
    });
    return revoked.length;
  }

  // Password reset/change, suspension, MFA reset: every session ends now.
  // Pass the caller's manager to make it atomic with that change.
  async revokeAllForUser(
    userId: string,
    manager: EntityManager,
    exceptSessionId?: string,
  ): Promise<string[]> {
    const [rows] = await manager.query<[{ familyId: string }[], number]>(
      `UPDATE refresh_tokens SET "revokedAt" = now()
        WHERE "userId" = $1 AND "revokedAt" IS NULL
          AND ($2::uuid IS NULL OR "familyId" <> $2::uuid)
        RETURNING "familyId"`,
      [userId, exceptSessionId ?? null],
    );
    const sessionIds = [...new Set(rows.map((row) => row.familyId))];
    await this.denylist.revoke(sessionIds);
    return sessionIds;
  }
}
