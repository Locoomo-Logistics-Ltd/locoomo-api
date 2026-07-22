import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { EmailAlreadyRegisteredException } from '../domain/exceptions/email-already-registered.exception';
import { hashPassword } from '../domain/password-hasher';
import { UserRole } from '../domain/user-role.enum';
import { UserStatus } from '../domain/user-status.enum';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { RegisterDto } from '../interface/dto/register.dto';
import { UserResponseDto } from '../interface/dto/user-response.dto';

@Injectable()
export class RegisterUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  async register(dto: RegisterDto): Promise<UserResponseDto> {
    const email = dto.email.toLowerCase();

    const existing = await this.users.findOneBy({ email });
    if (existing) {
      throw new EmailAlreadyRegisteredException(email);
    }

    const passwordHash = await hashPassword(dto.password);

    const user = this.users.create({
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

    try {
      const saved = await this.users.save(user);
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
