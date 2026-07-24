import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { InvalidInviteTokenException } from '../domain/exceptions/invalid-invite-token.exception';
import { hashPassword } from '../domain/password-hasher';
import { UserStatus } from '../domain/user-status.enum';
import { InviteTokenEntity } from '../infrastructure/entities/invite-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { ConfirmInviteDto } from '../interface/dto/confirm-invite.dto';

@Injectable()
export class ConfirmInviteService {
  constructor(
    @InjectRepository(InviteTokenEntity)
    private readonly inviteTokens: Repository<InviteTokenEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async confirmInvite(dto: ConfirmInviteDto): Promise<void> {
    const stored = await this.inviteTokens.findOneBy({
      tokenHash: hashToken(dto.token),
    });

    if (
      !stored ||
      stored.usedAt !== null ||
      stored.expiresAt.getTime() < Date.now()
    ) {
      throw new InvalidInviteTokenException();
    }

    const passwordHash = await hashPassword(dto.password);

    await this.dataSource.transaction(async (manager) => {
      await manager.update(InviteTokenEntity, stored.id, {
        usedAt: new Date(),
      });

      await manager.update(UserEntity, stored.userId, {
        passwordHash,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
        // Following the invite link is already proof of email ownership —
        // no separate verification email for admin-provisioned accounts.
        emailVerifiedAt: new Date(),
      });
    });
  }
}
