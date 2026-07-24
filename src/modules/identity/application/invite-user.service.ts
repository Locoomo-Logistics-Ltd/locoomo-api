import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { Env } from '../../../config/env.validation';
import { OutboxService } from '../../notifications/application/outbox.service';
import { EmailAlreadyRegisteredException } from '../domain/exceptions/email-already-registered.exception';
import { INVITE_TOKEN_TTL_DAYS } from '../domain/invite.constants';
import { UserStatus } from '../domain/user-status.enum';
import { InviteTokenEntity } from '../infrastructure/entities/invite-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { InviteUserDto } from '../interface/dto/invite-user.dto';
import { UserResponseDto } from '../interface/dto/user-response.dto';

@Injectable()
export class InviteUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async invite(dto: InviteUserDto): Promise<UserResponseDto> {
    const email = dto.email.toLowerCase();

    const existing = await this.users.findOneBy({ email });
    if (existing) {
      throw new EmailAlreadyRegisteredException(email);
    }

    const rawInviteToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const inviteLink = `${this.configService.get('FRONTEND_URL', { infer: true })}/accept-invite?token=${rawInviteToken}`;

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        const user = manager.create(UserEntity, {
          email,
          // Null until they follow the link and set one — never an
          // admin-set password.
          passwordHash: null,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          role: dto.role,
          status: UserStatus.INVITED,
          consentAcceptedAt: null,
        });
        const savedUser = await manager.save(user);

        await manager.save(
          manager.create(InviteTokenEntity, {
            userId: savedUser.id,
            tokenHash: hashToken(rawInviteToken),
            expiresAt,
            usedAt: null,
          }),
        );

        await this.outboxService.enqueueEmail(
          {
            to: savedUser.email,
            subject: "You've been invited to Locoomo",
            text: `You've been invited to join Locoomo as a ${dto.role}. Set your password to get started: ${inviteLink}\n\nThis link expires in ${INVITE_TOKEN_TTL_DAYS} days.`,
            html: `<p>You've been invited to join Locoomo as a ${dto.role}.</p><p>Set your password to get started:</p><p><a href="${inviteLink}">${inviteLink}</a></p><p>This link expires in ${INVITE_TOKEN_TTL_DAYS} days.</p>`,
          },
          manager,
        );

        return savedUser;
      });

      return UserResponseDto.fromEntity(saved);
    } catch (error) {
      // Pre-check above handles the common case; this catches the race
      // where two invites for the same email land concurrently.
      if (isUniqueViolation(error)) {
        throw new EmailAlreadyRegisteredException(email);
      }
      throw error;
    }
  }
}
