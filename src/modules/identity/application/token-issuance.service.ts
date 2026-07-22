import { randomBytes, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  // Starts a brand new token family — use on login. Rotation within an existing family is handled separately by the refresh endpoint.
  async issueSession(user: UserEntity): Promise<IssuedSession> {
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, role: user.role },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );

    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId: randomUUID(),
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
