import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { OutboxService } from '../../notifications/application/outbox.service';
import { InvalidResetTokenException } from '../domain/exceptions/invalid-reset-token.exception';
import { hashPassword } from '../domain/password-hasher';
import { PasswordResetTokenEntity } from '../infrastructure/entities/password-reset-token.entity';
import { RefreshTokenEntity } from '../infrastructure/entities/refresh-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { ConfirmPasswordResetDto } from '../interface/dto/confirm-password-reset.dto';

@Injectable()
export class ConfirmPasswordResetService {
  constructor(
    @InjectRepository(PasswordResetTokenEntity)
    private readonly resetTokens: Repository<PasswordResetTokenEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxService: OutboxService,
  ) {}

  async confirmReset(dto: ConfirmPasswordResetDto): Promise<void> {
    const stored = await this.resetTokens.findOne({
      where: { tokenHash: hashToken(dto.token) },
      relations: { user: true },
    });

    if (
      !stored ||
      stored.usedAt !== null ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      throw new InvalidResetTokenException();
    }

    const passwordHash = await hashPassword(dto.password);

    await this.dataSource.transaction(async (manager) => {
      await manager.update(PasswordResetTokenEntity, stored.id, {
        usedAt: new Date(),
      });

      await manager.update(UserEntity, stored.userId, {
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
      });

      // a password reset invalidates every session, not
      // just whichever device requested it.
      await manager.update(
        RefreshTokenEntity,
        { userId: stored.userId },
        { revokedAt: new Date() },
      );

      await this.outboxService.enqueueEmail(
        {
          to: stored.user.email,
          subject: 'Your Locoomo password was changed',
          text: `Your password was just changed. If this wasn't you, contact support immediately.`,
          html: `<p>Your password was just changed. If this wasn't you, contact support immediately.</p>`,
        },
        manager,
      );
    });
  }
}
