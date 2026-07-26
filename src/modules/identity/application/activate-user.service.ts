import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserStatus } from '../domain/user-status.enum';
import { UserEntity } from '../infrastructure/entities/user.entity';

// Exported narrowly for node-operators' approval flow, which needs to flip
// User.status=ACTIVE in the same transaction as Node.status=ACTIVE — never
// by reaching into identity's infrastructure directly.
@Injectable()
export class ActivateUserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  async activate(userId: string, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(UserEntity) : this.users;
    await repo.update(userId, { status: UserStatus.ACTIVE });
  }
}
