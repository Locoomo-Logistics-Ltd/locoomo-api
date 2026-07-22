import { Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { UserRole } from '../../src/modules/identity/domain/user-role.enum';
import { RefreshTokenEntity } from '../../src/modules/identity/infrastructure/entities/refresh-token.entity';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity]),
  ],
})
class RefreshTokenTestModule {}

function inOneHour(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

describe('RefreshTokenEntity (integration)', () => {
  let moduleRef: TestingModule;
  let users: Repository<UserEntity>;
  let refreshTokens: Repository<RefreshTokenEntity>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [RefreshTokenTestModule],
    }).compile();

    users = moduleRef.get(getRepositoryToken(UserEntity));
    refreshTokens = moduleRef.get(getRepositoryToken(RefreshTokenEntity));
  });

  afterAll(async () => {
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: '%@refresh-token.e2e.test' })
      .execute();
    await moduleRef.close();
  });

  async function createTestUser(email: string): Promise<UserEntity> {
    return users.save(
      users.create({
        email,
        firstName: 'Test',
        lastName: 'User',
        phone: '+2348000000000',
        role: UserRole.CONSUMER,
      }),
    );
  }

  it('persists a refresh token linked to a user, with sensible defaults', async () => {
    const user = await createTestUser('owner@refresh-token.e2e.test');

    const token = await refreshTokens.save(
      refreshTokens.create({
        userId: user.id,
        tokenHash: 'a'.repeat(64),
        familyId: crypto.randomUUID(),
        expiresAt: inOneHour(),
      }),
    );

    expect(token.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(token.revokedAt).toBeNull();
    expect(token.createdAt).toBeInstanceOf(Date);
  });

  it('enforces tokenHash uniqueness at the database level', async () => {
    const user = await createTestUser('dup-hash@refresh-token.e2e.test');
    const sharedHash = 'b'.repeat(64);

    await refreshTokens.save(
      refreshTokens.create({
        userId: user.id,
        tokenHash: sharedHash,
        familyId: crypto.randomUUID(),
        expiresAt: inOneHour(),
      }),
    );

    await expect(
      refreshTokens.save(
        refreshTokens.create({
          userId: user.id,
          tokenHash: sharedHash,
          familyId: crypto.randomUUID(),
          expiresAt: inOneHour(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a refresh token for a non-existent user (FK constraint)', async () => {
    await expect(
      refreshTokens.save(
        refreshTokens.create({
          userId: crypto.randomUUID(),
          tokenHash: 'c'.repeat(64),
          familyId: crypto.randomUUID(),
          expiresAt: inOneHour(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('cascade-deletes refresh tokens when their owning user is deleted', async () => {
    const user = await createTestUser('cascade@refresh-token.e2e.test');
    const token = await refreshTokens.save(
      refreshTokens.create({
        userId: user.id,
        tokenHash: 'd'.repeat(64),
        familyId: crypto.randomUUID(),
        expiresAt: inOneHour(),
      }),
    );

    await users.delete({ id: user.id });

    const found = await refreshTokens.findOneBy({ id: token.id });
    expect(found).toBeNull();
  });
});
