import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { Repository } from 'typeorm';

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

describe('POST /api/v1/auth/register (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;

  const validPayload = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@register.e2e.test',
    phone: '+2348012345678',
    password: 'Correct-Horse-Battery-1',
    passwordConfirmation: 'Correct-Horse-Battery-1',
    consentAccepted: true,
  };

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
      .where('email LIKE :pattern', { pattern: '%@register.e2e.test' })
      .execute();
    await app.close();
  });

  it('registers a new consumer and returns a safe response with no passwordHash', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(validPayload)
      .expect(201);

    const data = (response.body as SuccessBody).data;
    expect(data.email).toBe('ada@register.e2e.test');
    expect(data.role).toBe('consumer');
    expect(data.status).toBe('active');
    expect(data.passwordHash).toBeUndefined();
    expect(data.password).toBeUndefined();

    const stored = await users.findOneByOrFail({
      email: 'ada@register.e2e.test',
    });
    expect(stored.passwordHash).not.toBeNull();
    expect(stored.consentAcceptedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...validPayload, email: 'dup@register.e2e.test' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...validPayload, email: 'dup@register.e2e.test' })
      .expect(409);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects mismatched password confirmation', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ...validPayload,
        email: 'mismatch@register.e2e.test',
        passwordConfirmation: 'something-else',
      })
      .expect(400);

    const body = response.body as ErrorBody;
    const details = body.error.details as Array<{ field: string }>;
    expect(details.some((d) => d.field === 'passwordConfirmation')).toBe(true);
  });

  it('rejects registration without accepting consent', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ...validPayload,
        email: 'noconsent@register.e2e.test',
        consentAccepted: false,
      })
      .expect(400);

    const body = response.body as ErrorBody;
    const details = body.error.details as Array<{ field: string }>;
    expect(details.some((d) => d.field === 'consentAccepted')).toBe(true);
  });

  it('rejects a password shorter than 12 characters', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ...validPayload,
        email: 'shortpw@register.e2e.test',
        password: 'short1',
        passwordConfirmation: 'short1',
      })
      .expect(400);
  });

  it('rejects an invalid email format', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...validPayload, email: 'not-an-email' })
      .expect(400);
  });

  it('never lets the client assign its own role — field is stripped and rejected', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ...validPayload,
        email: 'roleattempt@register.e2e.test',
        role: 'admin',
      })
      .expect(400);

    const body = response.body as ErrorBody;
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
