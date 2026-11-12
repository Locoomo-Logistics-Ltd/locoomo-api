import { randomBytes, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AccessTokenPayload } from '../../../common/auth/access-token-payload';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS,
} from '../domain/session-token.constants';
import { hashRefreshToken } from '../domain/refresh-token-hasher';
import { RefreshTokenEntity } from '../infrastructure/entities/refresh-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  refreshTokenExpiresAt: Date;
  // Refresh-token family id — the `sid` claim and the id shown in
  // GET /auth/sessions.
  sessionId: string;
}

// Where a session was started/used from, for the sessions list.
export interface SessionClient {
  ip: string | null;
  userAgent: string | null;
}

export const UNKNOWN_CLIENT: SessionClient = { ip: null, userAgent: null };

@Injectable()
export class TokenIssuanceService {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokens: Repository<RefreshTokenEntity>,
  ) {}

  // Starts a brand new token family — use on login. A login that just
  // passed 2FA (or a fresh password) counts as a step-up: `reauthAt` is set
  // so the user isn't asked to confirm again for the next few minutes.
  issueSession(
    user: UserEntity,
    client: SessionClient = UNKNOWN_CLIENT,
    options: { reauthenticated?: boolean } = {},
  ): Promise<IssuedSession> {
    return this.createSession(user, randomUUID(), client, options);
  }

  // Rotation within an existing family — use on refresh. Keeping the same
  // familyId is what lets a replayed, already-rotated token be recognized as
  // theft and revoke every token descended from it, not just itself.
  rotateSession(
    user: UserEntity,
    familyId: string,
    client: SessionClient = UNKNOWN_CLIENT,
  ): Promise<IssuedSession> {
    return this.createSession(user, familyId, client, {});
  }

  // A new access token for an existing session (no new refresh token) —
  // step-up re-authentication.
  async issueAccessToken(
    user: Pick<UserEntity, 'id' | 'role'>,
    sessionId: string | undefined,
    reauthAt: number | undefined,
  ): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      ...(sessionId ? { sid: sessionId } : {}),
      ...(reauthAt ? { reauthAt } : {}),
    };
    return this.jwtService.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  private async createSession(
    user: UserEntity,
    familyId: string,
    client: SessionClient,
    options: { reauthenticated?: boolean },
    manager?: EntityManager,
  ): Promise<IssuedSession> {
    const accessToken = await this.issueAccessToken(
      user,
      familyId,
      options.reauthenticated ? Math.floor(Date.now() / 1000) : undefined,
    );

    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const repo = manager
      ? manager.getRepository(RefreshTokenEntity)
      : this.refreshTokens;
    await repo.save(
      repo.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId,
        expiresAt: refreshTokenExpiresAt,
        revokedAt: null,
        ip: client.ip,
        userAgent: client.userAgent?.slice(0, 500) ?? null,
      }),
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresAt,
      sessionId: familyId,
    };
  }
}
