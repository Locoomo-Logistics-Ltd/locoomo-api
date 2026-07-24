import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { InvalidVerificationTokenException } from '../domain/exceptions/invalid-verification-token.exception';
import { EmailVerificationTokenEntity } from '../infrastructure/entities/email-verification-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { ConfirmEmailVerificationDto } from '../interface/dto/confirm-email-verification.dto';

@Injectable()
export class VerifyEmailService {
  constructor(
    @InjectRepository(EmailVerificationTokenEntity)
    private readonly verificationTokens: Repository<EmailVerificationTokenEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async verifyEmail(dto: ConfirmEmailVerificationDto): Promise<void> {
    const stored = await this.verificationTokens.findOneBy({
      tokenHash: hashToken(dto.token),
    });

    if (
      !stored ||
      stored.usedAt !== null ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      throw new InvalidVerificationTokenException();
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(EmailVerificationTokenEntity, stored.id, {
        usedAt: new Date(),
      });

      await manager.update(UserEntity, stored.userId, {
        emailVerifiedAt: new Date(),
      });
    });
  }
}
