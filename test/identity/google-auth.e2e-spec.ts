import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { GoogleIdTokenVerifier } from '../../src/modules/identity/infrastructure/google-id-token-verifier';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

// Fakes the Google JWKS/signature-verification boundary — the idToken sent
// by tests is a plain JSON-encoded GoogleIdentity, not a real JWT. Real
// signature/audience/expiry verification is Google's own library's job, not
// this codebase's; the token '__invalid__' simulates any verification
// failure (bad signature, wrong audience, expired, malformed).
class FakeGoogleIdTokenVerifier {
  verify(idToken: string) {
    if (idToken === '__invalid__') {
      return Promise.resolve(null);
    }
    return Promise.resolve(JSON.parse(idToken));
  }
}

function fakeIdToken(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sub: `google-sub-${Math.random().toString(36).slice(2)}`,
    email: `google-${Math.random().toString(36).slice(2)}@google-auth.e2e.test`,
    emailVerified: true,
    givenName: 'Ada',
    familyName: 'Lovelace',
    ...overrides,
  });
}

describe('POST /api/v1/auth/google (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleIdTokenVerifier)
      .useValue(new FakeGoogleIdTokenVerifier())
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
  });

  afterAll(async () => {
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: '%@google-auth.e2e.test' })
      .execute();
    await app.close();
  });

  it('signs up a new consumer, active immediately, with session cookies and no phone', async () => {
    const idToken = fakeIdToken();
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken, consentAccepted: true })
      .expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.role).toBe('consumer');
    expect(data.status).toBe('active');
    expect(data.phone).toBeNull();
    expect(data.passwordHash).toBeUndefined();

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('access_token='))).toBe(true);
    expect(setCookie.some((c) => c.startsWith('refresh_token='))).toBe(true);

    const stored = await users.findOneByOrFail({ email: data.email as string });
    expect(stored.passwordHash).toBeNull();
    expect(stored.googleId).not.toBeNull();
    expect(stored.emailVerifiedAt).not.toBeNull();
    expect(stored.consentAcceptedAt).not.toBeNull();
  });

  it('signs up a new rider into pending_review, still with a live session', async () => {
    const idToken = fakeIdToken();
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken, role: 'rider', consentAccepted: true })
      .expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.role).toBe('rider');
    expect(data.status).toBe('pending_review');

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('access_token='))).toBe(true);
  });

  it('rejects a signup without accepting consent', async () => {
    const idToken = fakeIdToken();
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken })
      .expect(400);

    expect((response.body as ErrorBody).error.code).toBe('CONSENT_REQUIRED');
  });

  it('falls back to splitting the name claim when given_name/family_name are absent', async () => {
    const idToken = fakeIdToken({
      givenName: undefined,
      familyName: undefined,
      name: 'Grace Hopper',
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken, consentAccepted: true })
      .expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.firstName).toBe('Grace');
    expect(data.lastName).toBe('Hopper');
  });

  it('rejects a token verification failure with 401', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: '__invalid__', consentAccepted: true })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_GOOGLE_TOKEN',
    );
  });

  it('rejects an unverified email claim with 401', async () => {
    const idToken = fakeIdToken({ emailVerified: false });
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken, consentAccepted: true })
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe(
      'INVALID_GOOGLE_TOKEN',
    );
  });

  it('logs an existing Google-linked user back in, ignoring role/consent', async () => {
    const email = `returning-${Math.random().toString(36).slice(2)}@google-auth.e2e.test`;
    const sub = `google-sub-returning-${Math.random().toString(36).slice(2)}`;
    const idToken = fakeIdToken({ sub, email });

    await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken, consentAccepted: true })
      .expect(200);

    // Second call, same sub, no consentAccepted/role at all — a plain login.
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: fakeIdToken({ sub, email }) })
      .expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.email).toBe(email);
    expect(data.role).toBe('consumer');

    const rows = await users.find({ where: { email } });
    expect(rows).toHaveLength(1);
  });

  it('rejects a verified email matching an existing (non-Google) account — no auto-link', async () => {
    const email = `passwordbased@google-auth.e2e.test`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Password',
        lastName: 'Based',
        email,
        password: 'Correct-Horse-Battery-1',
        passwordConfirmation: 'Correct-Horse-Battery-1',
        consentAccepted: true,
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: fakeIdToken({ email }), consentAccepted: true })
      .expect(409);

    expect((response.body as ErrorBody).error.code).toBe(
      'EMAIL_ALREADY_REGISTERED',
    );

    const stored = await users.findOneByOrFail({ email });
    expect(stored.googleId).toBeNull();
    expect(stored.passwordHash).not.toBeNull();
  });

  it('rejects a suspended Google-linked account', async () => {
    const email = `suspended@google-auth.e2e.test`;
    const sub = 'google-sub-suspended';
    const idToken = fakeIdToken({ sub, email });

    await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken, consentAccepted: true })
      .expect(200);

    await users.update({ email }, { status: UserStatus.SUSPENDED });

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({ idToken: fakeIdToken({ sub, email }) })
      .expect(403);

    expect((response.body as ErrorBody).error.code).toBe('ACCOUNT_SUSPENDED');
  });
});
