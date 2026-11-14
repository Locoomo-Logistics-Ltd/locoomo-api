import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
import { AccountSuspendedException } from '../domain/exceptions/account-suspended.exception';
import { UserStatus } from '../domain/user-status.enum';
import { UserEntity } from '../infrastructure/entities/user.entity';

export interface UserContact {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

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

  // Name + email for notifications (merchants: team emails). Unknown ids
  // are skipped rather than thrown — a deleted user just isn't emailed.
  async getContacts(userIds: readonly string[]): Promise<UserContact[]> {
    if (userIds.length === 0) {
      return [];
    }
    const users = await this.users.findBy({ id: In([...userIds]) });
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    }));
  }

  // Lowercases for the caller. Null when no account uses this address.
  async findIdByEmail(email: string): Promise<string | null> {
    const user = await this.users.findOne({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });
    return user?.id ?? null;
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
