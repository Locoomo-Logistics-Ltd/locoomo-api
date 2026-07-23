import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hashRefreshToken } from '../domain/refresh-token-hasher';
import { RefreshTokenEntity } from '../infrastructure/entities/refresh-token.entity';

// Revokes only the current session's refresh token — not the whole family.
// Logging out of one device shouldn't sign every other device out; that's
// reserved for theft detection (see RefreshSessionService) and password reset.
@Injectable()
export class LogoutUserService {
  constructor(
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokens: Repository<RefreshTokenEntity>,
  ) {}

  // No refresh token to revoke is not an error — logging out when already
  // logged out just means the desired end state is already true.
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) {
      return;
    }

    await this.refreshTokens.update(
      { tokenHash: hashRefreshToken(rawToken) },
      { revokedAt: new Date() },
    );
  }
}
