import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { AccessTokenPayload } from '../../src/modules/identity/domain/access-token-payload';
import { UserRole } from '../../src/modules/identity/domain/user-role.enum';
import { CurrentUser } from '../../src/modules/identity/interface/decorators/current-user.decorator';
import { Public } from '../../src/modules/identity/interface/decorators/public.decorator';
import { Roles } from '../../src/modules/identity/interface/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../src/modules/identity/interface/authenticated-user';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

// Only registered inside this test's TestingModule — never part of the real
// app. Exercises the global AuthGuard/RolesGuard (both wired by
// IdentityModule, part of the real AppModule) against routes that don't
// exist in production, so we can prove every branch without needing a real
// protected business endpoint to exist yet.
@Controller('test-auth')
class AuthTestController {
  @Public()
  @Get('public')
  publicRoute(): { ok: boolean } {
    return { ok: true };
  }

  @Get('protected')
  protectedRoute(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Roles(UserRole.ADMIN)
  @Get('admin-only')
  adminRoute(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [AuthTestController] })
class AuthTestModule {}

interface ErrorBody {
  success: false;
  error: { code: string };
}

interface SuccessBody<T> {
  success: true;
  data: T;
}

describe('AuthGuard / RolesGuard (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let users: Repository<UserEntity>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, AuthTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    jwtService = moduleFixture.get(JwtService);
    users = moduleFixture.get(getRepositoryToken(UserEntity));
  });

  afterAll(async () => {
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: '%@auth-guard.e2e.test' })
      .execute();
    await app.close();
  });

  function signAccessToken(
    payload: AccessTokenPayload,
    expiresInSeconds = 900,
  ): string {
    return jwtService.sign(payload, { expiresIn: expiresInSeconds });
  }

  it('allows a @Public() route with no cookie at all', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/test-auth/public')
      .expect(200);
  });

  it('rejects a protected route with no access token cookie', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test-auth/protected')
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a protected route with a garbage access token cookie', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test-auth/protected')
      .set('Cookie', ['access_token=not-a-real-jwt'])
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a protected route with an expired access token', async () => {
    const expiredToken = signAccessToken(
      { sub: 'some-user-id', role: UserRole.CONSUMER },
      -10,
    );

    const response = await request(app.getHttpServer())
      .get('/api/v1/test-auth/protected')
      .set('Cookie', [`access_token=${expiredToken}`])
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('allows a protected route with a valid access token and exposes the payload via @CurrentUser()', async () => {
    const token = signAccessToken({
      sub: 'user-123',
      role: UserRole.CONSUMER,
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/test-auth/protected')
      .set('Cookie', [`access_token=${token}`])
      .expect(200);

    const data = (response.body as SuccessBody<AuthenticatedUser>).data;
    expect(data).toEqual({ id: 'user-123', role: 'consumer' });
  });

  it('rejects a role-gated route with no session before checking role', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test-auth/admin-only')
      .expect(401);

    expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a role-gated route for an authenticated user with the wrong role', async () => {
    const token = signAccessToken({
      sub: 'user-123',
      role: UserRole.CONSUMER,
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/test-auth/admin-only')
      .set('Cookie', [`access_token=${token}`])
      .expect(403);

    expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
  });

  it('allows a role-gated route for a user with the required role', async () => {
    const token = signAccessToken({ sub: 'admin-1', role: UserRole.ADMIN });

    await request(app.getHttpServer())
      .get('/api/v1/test-auth/admin-only')
      .set('Cookie', [`access_token=${token}`])
      .expect(200);
  });

  it('lets the real, unauthenticated /api/v1/auth/register route through', async () => {
    // Sanity check that @Public() on AuthController still works end to end
    // now that the global guard is active for everything else.
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Guard',
        lastName: 'Tester',
        email: 'guardcheck@auth-guard.e2e.test',
        phone: '+2348012345678',
        password: 'Correct-Horse-Battery-1',
        passwordConfirmation: 'Correct-Horse-Battery-1',
        consentAccepted: true,
      })
      .expect(201);
  });

  it('/health remains reachable without a session', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
