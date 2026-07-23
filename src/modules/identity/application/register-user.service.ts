import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { hashToken } from '../../../common/crypto/hash-token.util';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { Env } from '../../../config/env.validation';
import { OutboxService } from '../../notifications/application/outbox.service';
import { EMAIL_VERIFICATION_TOKEN_TTL_HOURS } from '../domain/email-verification.constants';
import { EmailAlreadyRegisteredException } from '../domain/exceptions/email-already-registered.exception';
import { hashPassword } from '../domain/password-hasher';
import { UserRole } from '../domain/user-role.enum';
import { UserStatus } from '../domain/user-status.enum';
import { EmailVerificationTokenEntity } from '../infrastructure/entities/email-verification-token.entity';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { RegisterDto } from '../interface/dto/register.dto';
import { UserResponseDto } from '../interface/dto/user-response.dto';

@Injectable()
export class RegisterUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  async register(dto: RegisterDto): Promise<UserResponseDto> {
    const email = dto.email.toLowerCase();

    const existing = await this.users.findOneBy({ email });
    if (existing) {
      throw new EmailAlreadyRegisteredException(email);
    }

    const passwordHash = await hashPassword(dto.password);
    const rawVerificationToken = randomBytes(32).toString('hex');
    const verificationExpiresAt = new Date(
      Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );
    const verificationLink = `${this.configService.get('FRONTEND_URL', { infer: true })}/verify-email?token=${rawVerificationToken}`;

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        const user = manager.create(UserEntity, {
          email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          role: UserRole.CONSUMER,
          // Consumer self-registration sets a password immediately — unlike
          // Admin-provisioned roles, there's no separate "set your password"
          // step, so the account is active right away.
          status: UserStatus.ACTIVE,
          consentAcceptedAt: new Date(),
        });
        const savedUser = await manager.save(user);

        await manager.save(
          manager.create(EmailVerificationTokenEntity, {
            userId: savedUser.id,
            tokenHash: hashToken(rawVerificationToken),
            expiresAt: verificationExpiresAt,
            usedAt: null,
          }),
        );

        await this.outboxService.enqueueEmail(
          {
            to: savedUser.email,
            subject: 'Verify your Locoomo email',
            text: `Welcome to Locoomo! Verify your email: ${verificationLink}\n\nThis link expires in ${EMAIL_VERIFICATION_TOKEN_TTL_HOURS} hours.`,
            html: `<p>Welcome to Locoomo!</p><p>Verify your email by clicking the link below:</p><p><a href="${verificationLink}">${verificationLink}</a></p><p>This link expires in ${EMAIL_VERIFICATION_TOKEN_TTL_HOURS} hours.</p>`,
          },
          manager,
        );

        return savedUser;
      });

      return UserResponseDto.fromEntity(saved);
    } catch (error) {
      // Pre-check above handles the common case; this catches the race
      // where two requests for the same email land concurrently.
      if (isUniqueViolation(error)) {
        throw new EmailAlreadyRegisteredException(email);
      }
      throw error;
    }
  }
}
