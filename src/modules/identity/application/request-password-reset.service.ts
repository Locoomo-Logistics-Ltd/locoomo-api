import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { Env } from '../../../config/env.validation';
import { OutboxService } from '../../notifications/application/outbox.service';
import { PASSWORD_RESET_TOKEN_TTL_MINUTES } from '../domain/password-reset.constants';
import { PasswordResetTokenEntity } from '../infrastructure/entities/password-reset-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { RequestPasswordResetDto } from '../interface/dto/request-password-reset.dto';

@Injectable()
export class RequestPasswordResetService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  // Always resolves with nothing exposed to the caller — whether the email
  // is registered, unregistered, or belongs to an invited (no-password-yet)
  // account must be indistinguishable from the response, same enumeration
  // reasoning as InvalidCredentialsException.
  async requestReset(dto: RequestPasswordResetDto): Promise<void> {
    const email = dto.email.toLowerCase();
    const user = await this.users.findOneBy({ email });

    if (!user || !user.passwordHash) {
      return;
    }

    const rawToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000,
    );
    const resetLink = `${this.configService.get('FRONTEND_URL', { infer: true })}/reset-password?token=${rawToken}`;

    await this.dataSource.transaction(async (manager) => {
      // Superseded by the one we're about to create — only the most
      // recently requested link should ever be valid.
      await manager.delete(PasswordResetTokenEntity, {
        userId: user.id,
        usedAt: IsNull(),
      });

      await manager.save(
        manager.create(PasswordResetTokenEntity, {
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt,
          usedAt: null,
        }),
      );

      await this.outboxService.enqueueEmail(
        {
          to: user.email,
          subject: 'Reset your Locoomo password',
          text: `Reset your password: ${resetLink}\n\nThis link expires in ${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.`,
          html: `<p>Reset your password by clicking the link below:</p><p><a href="${resetLink}">${resetLink}</a></p><p>This link expires in ${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.</p>`,
        },
        manager,
      );
    });
  }
}
