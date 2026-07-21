import { Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { UserRole } from '../../src/modules/identity/domain/user-role.enum';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    TypeOrmModule.forFeature([UserEntity]),
  ],
})
class UserEntityTestModule {}

describe('UserEntity (integration)', () => {
  let moduleRef: TestingModule;
  let repository: Repository<UserEntity>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [UserEntityTestModule],
    }).compile();

    repository = moduleRef.get(getRepositoryToken(UserEntity));
  });

  afterAll(async () => {
    await repository
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: '%@user-entity.e2e.test' })
      .execute();
    await moduleRef.close();
  });

  it('persists and reads back a user with correct defaults and types', async () => {
    const created = await repository.save(
      repository.create({
        email: 'persist-read@user-entity.e2e.test',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+2348000000000',
        role: UserRole.CONSUMER,
      }),
    );

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.status).toBe(UserStatus.INVITED);
    expect(created.passwordHash).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);

    const found = await repository.findOneByOrFail({ id: created.id });
    expect(found.email).toBe('persist-read@user-entity.e2e.test');
    expect(found.role).toBe(UserRole.CONSUMER);
  });

  it('enforces email uniqueness at the database level', async () => {
    const email = 'duplicate@user-entity.e2e.test';

    await repository.save(
      repository.create({
        email,
        firstName: 'Dup',
        lastName: 'Licate',
        phone: '+2348000000001',
        role: UserRole.CONSUMER,
      }),
    );

    await expect(
      repository.save(
        repository.create({
          email,
          firstName: 'Dup',
          lastName: 'Licate2',
          phone: '+2348000000002',
          role: UserRole.CONSUMER,
        }),
      ),
    ).rejects.toThrow();
  });
});
