import { randomBytes, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessTokenPayload } from '../domain/access-token-payload';
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
}

@Injectable()
export class TokenIssuanceService {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokens: Repository<RefreshTokenEntity>,
  ) {}

  // Starts a brand new token family — use on login.
  issueSession(user: UserEntity): Promise<IssuedSession> {
    return this.createSession(user, randomUUID());
  }

  // Rotation within an existing family — use on refresh. Keeping the same
  // familyId is what lets a replayed, already-rotated token be recognized as
  // theft and revoke every token descended from it, not just itself.
  rotateSession(user: UserEntity, familyId: string): Promise<IssuedSession> {
    return this.createSession(user, familyId);
  }

  private async createSession(
    user: UserEntity,
    familyId: string,
  ): Promise<IssuedSession> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role };
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId,
        expiresAt: refreshTokenExpiresAt,
        revokedAt: null,
      }),
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresAt,
    };
  }
}
