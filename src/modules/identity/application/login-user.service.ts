import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

    // No password hash yet means an Admin-provisioned account that hasn't completed its "set your password" invite step — same generic error, not a distinct one, to avoid leaking account state pre-authentication.

    if (!user || !user.passwordHash) {
      throw new InvalidCredentialsException();
    }

    const passwordValid = await verifyPassword(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new InvalidCredentialsException();
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new AccountSuspendedException();
    }

    const session = await this.tokenIssuanceService.issueSession(user);
    return { user, session };
  }
}
