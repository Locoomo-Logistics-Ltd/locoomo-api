import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: unknown;
  };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

describe('GET/PATCH /api/v1/users/me (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  const password = 'Correct-Horse-Battery-1';

  async function registerAndLogin(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Me',
        lastName: 'Tester',
        email,
        password,
        passwordConfirmation: password,
        consentAccepted: true,
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const setCookie = response.headers['set-cookie'] as unknown as string[];
    const accessCookie = setCookie.find((c) => c.startsWith('access_token='));
    if (!accessCookie) {
      throw new Error('No access_token cookie in login response');
    }
    return accessCookie.split(';')[0];
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
  });

  afterAll(async () => {
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: '%@users-me.e2e.test' })
      .execute();
    await app.close();
  });

  it('rejects an unauthenticated request to both routes', async () => {
    await request(app.getHttpServer()).get('/api/v1/users/me').expect(401);
    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .send({ phone: '+2348012345678' })
      .expect(401);
  });

  it('returns the caller’s own profile with phone null after registration', async () => {
    const cookie = await registerAndLogin('getme@users-me.e2e.test');
    const response = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Cookie', [cookie])
      .expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.email).toBe('getme@users-me.e2e.test');
    expect(data.phone).toBeNull();
    expect(data.passwordHash).toBeUndefined();
  });

  it('sets phone via PATCH and reflects it on a subsequent GET', async () => {
    const email = 'patchme@users-me.e2e.test';
    const cookie = await registerAndLogin(email);

    const patchResponse = await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Cookie', [cookie])
      .send({ phone: '+2348099999999' })
      .expect(200);
    expect((patchResponse.body as SuccessBody).data.phone).toBe(
      '+2348099999999',
    );

    const getResponse = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Cookie', [cookie])
      .expect(200);
    expect((getResponse.body as SuccessBody).data.phone).toBe('+2348099999999');

    const stored = await users.findOneByOrFail({ email });
    expect(stored.phone).toBe('+2348099999999');
  });

  it('rejects an invalid phone format', async () => {
    const cookie = await registerAndLogin('badphone@users-me.e2e.test');
    const response = await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Cookie', [cookie])
      .send({ phone: 'not-a-phone' })
      .expect(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_FAILED');
  });
});
