import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityNotFoundException } from '../../../common/exceptions';
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
}
