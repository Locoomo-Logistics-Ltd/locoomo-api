import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountSuspendedException } from '../domain/exceptions/account-suspended.exception';
import { InvalidRefreshTokenException } from '../domain/exceptions/invalid-refresh-token.exception';
import { hashRefreshToken } from '../domain/refresh-token-hasher';
import { UserStatus } from '../domain/user-status.enum';
import { RefreshTokenEntity } from '../infrastructure/entities/refresh-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { IssuedSession, TokenIssuanceService } from './token-issuance.service';

export interface RefreshResult {
  user: UserEntity;
  session: IssuedSession;
}

@Injectable()
export class RefreshSessionService {
  constructor(
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokens: Repository<RefreshTokenEntity>,
    private readonly tokenIssuanceService: TokenIssuanceService,
  ) {}

  async refresh(rawToken: string): Promise<RefreshResult> {
    const stored = await this.refreshTokens.findOne({
      where: { tokenHash: hashRefreshToken(rawToken) },
      relations: { user: true },
    });

    if (!stored) {
      throw new InvalidRefreshTokenException();
    }

    // Replaying a token that's already been rotated (or already revoked for
    // any other reason) means whoever's presenting it isn't the legitimate
    // holder of the current one — treat the whole family as compromised, not
    // just this token.
    if (stored.revokedAt !== null) {
      await this.refreshTokens.update(
        { familyId: stored.familyId },
        { revokedAt: new Date() },
      );
      throw new InvalidRefreshTokenException();
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new InvalidRefreshTokenException();
    }

    if (stored.user.status === UserStatus.SUSPENDED) {
      throw new AccountSuspendedException();
    }

    stored.revokedAt = new Date();
    await this.refreshTokens.save(stored);

    const session = await this.tokenIssuanceService.rotateSession(
      stored.user,
      stored.familyId,
    );

    return { user: stored.user, session };
  }
}
