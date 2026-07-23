import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  LOCKOUT_DURATION_MINUTES,
  MAX_FAILED_LOGIN_ATTEMPTS,
} from '../domain/account-lockout.constants';
import { AccountSuspendedException } from '../domain/exceptions/account-suspended.exception';
import { InvalidCredentialsException } from '../domain/exceptions/invalid-credentials.exception';
import { verifyPassword } from '../domain/password-hasher';
import { UserStatus } from '../domain/user-status.enum';
import { UserEntity } from '../infrastructure/entities/user.entity';
import { LoginDto } from '../interface/dto/login.dto';
import { IssuedSession, TokenIssuanceService } from './token-issuance.service';

export interface LoginResult {
  user: UserEntity;
  session: IssuedSession;
}

@Injectable()
export class LoginUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly tokenIssuanceService: TokenIssuanceService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.users.findOneBy({
      email: dto.email.toLowerCase(),
    });

    if (!user || !user.passwordHash) {
      throw new InvalidCredentialsException();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new InvalidCredentialsException();
    }

    const passwordValid = await verifyPassword(dto.password, user.passwordHash);
    if (!passwordValid) {
      await this.registerFailedAttempt(user);
      throw new InvalidCredentialsException();
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      await this.users.save(user);
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new AccountSuspendedException();
    }

    const session = await this.tokenIssuanceService.issueSession(user);
    return { user, session };
  }

  private async registerFailedAttempt(user: UserEntity): Promise<void> {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
      user.lockedUntil = new Date(
        Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000,
      );
    }
    await this.users.save(user);
  }
}
