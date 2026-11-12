import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { AccountSuspendedException } from '../domain/exceptions/account-suspended.exception';
import { UserStatus } from '../domain/user-status.enum';
import { UserEntity } from '../infrastructure/entities/user.entity';

@Injectable()
export class UserLookupService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  async getEmail(userId: string): Promise<string> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new EntityNotFoundException('User', userId);
    }
    return user.email;
  }

  // Exported so riders/node-operators can gate onboarding on "has this
  // account completed its profile" without importing UserEntity or
  // reaching into identity's domain/infrastructure directly — see
  // OnboardRiderService/OnboardNodeService.
  async getPhone(userId: string): Promise<string | null> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new EntityNotFoundException('User', userId);
    }
    return user.phone;
  }

  // For finishing a sign-in (after 2FA): the account may have been
  // suspended in the minutes since the password was checked.
  async getActiveUserForSession(userId: string): Promise<UserEntity> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new EntityNotFoundException('User', userId);
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new AccountSuspendedException();
    }
    return user;
  }
}
