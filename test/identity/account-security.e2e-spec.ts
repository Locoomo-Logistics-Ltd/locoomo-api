import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { AdminPermission } from '../../src/common/auth/admin-permission.enum';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import {
  base32Decode,
  hotp,
  totpStep,
} from '../../src/modules/identity/domain/totp';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

const PASSWORD = 'Correct-Horse-Battery-1';

interface ErrorBody {
  success: false;
  error: { code: string };
}
interface Data<T> {
  data: T;
}

function cookiesFrom(response: request.Response): Record<string, string> {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  const jar: Record<string, string> = {};
  for (const cookie of raw ?? []) {
    const [pair] = cookie.split(';');
    const [name, ...rest] = pair.split('=');
    jar[name] = rest.join('=');
  }
  return jar;
}

describe('Account security: sessions, step-up, 2FA (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let jwt: JwtService;
  let dataSource: DataSource;
  const emailPattern = '%@account-security.e2e.test';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function makeUser(
    name: string,
    overrides: Partial<UserEntity> = {},
  ): Promise<UserEntity> {
    return users.save(
      users.create({
        email: `${name}@account-security.e2e.test`,
        passwordHash: await hashPassword(PASSWORD),
        firstName: name,
        lastName: 'Tester',
        role: UserRole.CONSUMER,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
        emailVerifiedAt: new Date(),
        ...overrides,
      }),
    );
  }

  async function login(email: string): Promise<{
    access: string;
    refresh: string;
    body: Record<string, unknown>;
  }> {
    const response = await http()
      .post('/api/v1/auth/login')
      .set('User-Agent', 'e2e-agent')
      .send({ email, password: PASSWORD })
      .expect(200);
    const jar = cookiesFrom(response);
    return {
      access: jar.access_token,
      refresh: jar.refresh_token,
      body: (response.body as Data<Record<string, unknown>>).data,
    };
  }

  const asAccess = (token: string): string[] => [`access_token=${token}`];

  // What an authenticator app shows `offset` periods from now.
  const codeFor = (secret: string, offset = 0): string =>
    hotp(base32Decode(secret), totpStep() + offset);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    users = moduleFixture.get(getRepositoryToken(UserEntity));
    jwt = moduleFixture.get(JwtService);
    dataSource = moduleFixture.get(DataSource);
  });

  afterAll(async () => {
    try {
      await dataSource.query(
        `DELETE FROM audit_events WHERE "actorId" IN (SELECT id FROM users WHERE email LIKE $1)`,
        [emailPattern],
      );
      await users
        .createQueryBuilder()
        .delete()
        .where('email LIKE :pattern', { pattern: emailPattern })
        .execute();
    } finally {
      await app.close();
    }
  });

  describe('sessions', () => {
    it('lists active sessions, marks the current one, and revokes another immediately', async () => {
      const user = await makeUser('sessions');
      const first = await login(user.email);
      const second = await login(user.email);

      const list = await http()
        .get('/api/v1/auth/sessions')
        .set('Cookie', asAccess(first.access))
        .expect(200);
      const sessions = (
        list.body as Data<{ id: string; current: boolean; userAgent: string }[]>
      ).data;
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);
      expect(sessions[0].userAgent).toBe('e2e-agent');

      const other = sessions.find((s) => !s.current);
      await http()
        .delete(`/api/v1/auth/sessions/${other?.id}`)
        .set('Cookie', asAccess(first.access))
        .expect(200);

      // The revoked session's still-unexpired access token is dead now.
      await http()
        .get('/api/v1/users/me')
        .set('Cookie', asAccess(second.access))
        .expect(401);
      await http()
        .get('/api/v1/users/me')
        .set('Cookie', asAccess(first.access))
        .expect(200);
    });

    it('signs out everywhere else but keeps the current session', async () => {
      const user = await makeUser('revoke-others');
      const keep = await login(user.email);
      const a = await login(user.email);
      const b = await login(user.email);

      const response = await http()
        .post('/api/v1/auth/sessions/revoke-others')
        .set('Cookie', asAccess(keep.access))
        .expect(200);
      expect((response.body as Data<{ revoked: number }>).data.revoked).toBe(2);

      for (const s of [a, b]) {
        await http()
          .get('/api/v1/users/me')
          .set('Cookie', asAccess(s.access))
          .expect(401);
      }
      await http()
        .get('/api/v1/users/me')
        .set('Cookie', asAccess(keep.access))
        .expect(200);
    });

    it('logout kills the access token straight away, not in 15 minutes', async () => {
      const user = await makeUser('logout');
      const s = await login(user.email);
      await http()
        .post('/api/v1/auth/logout')
        .set('Cookie', [`refresh_token=${s.refresh}`])
        .expect(200);
      await http()
        .get('/api/v1/users/me')
        .set('Cookie', asAccess(s.access))
        .expect(401);
    });
  });

  describe('step-up re-authentication', () => {
    it('requires a recent re-auth for sensitive actions, and grants it for the right password', async () => {
      const user = await makeUser('stepup');
      // A token without reauthAt (e.g. after a refresh).
      const stale = jwt.sign({ sub: user.id, role: user.role });

      const refused = await http()
        .post('/api/v1/auth/mfa/totp/setup')
        .set('Cookie', asAccess(stale))
        .expect(403);
      expect((refused.body as ErrorBody).error.code).toBe('REAUTH_REQUIRED');

      await http()
        .post('/api/v1/auth/reauth')
        .set('Cookie', asAccess(stale))
        .send({ password: 'wrong-password-123' })
        .expect(401);

      const ok = await http()
        .post('/api/v1/auth/reauth')
        .set('Cookie', asAccess(stale))
        .send({ password: PASSWORD })
        .expect(200);
      const fresh = cookiesFrom(ok).access_token;
      expect(fresh).toBeDefined();

      await http()
        .post('/api/v1/auth/mfa/totp/setup')
        .set('Cookie', asAccess(fresh))
        .expect(200);
    });
  });

  describe('two-factor authentication', () => {
    let user: UserEntity;
    let secret: string;
    let recoveryCodes: string[];

    beforeAll(async () => {
      user = await makeUser('mfa');
      const s = await login(user.email); // fresh login counts as step-up

      const setup = await http()
        .post('/api/v1/auth/mfa/totp/setup')
        .set('Cookie', asAccess(s.access))
        .expect(200);
      const data = (
        setup.body as Data<{
          secret: string;
          otpauthUrl: string;
          qrDataUrl: string;
        }>
      ).data;
      secret = data.secret;
      expect(data.otpauthUrl).toContain('otpauth://totp/');
      expect(data.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);

      const confirm = await http()
        .post('/api/v1/auth/mfa/totp/confirm')
        .set('Cookie', asAccess(s.access))
        .send({ code: codeFor(secret) })
        .expect(200);
      recoveryCodes = (confirm.body as Data<{ recoveryCodes: string[] }>).data
        .recoveryCodes;
      expect(recoveryCodes).toHaveLength(10);
    });

    it('stores the seed encrypted, never in the clear', async () => {
      const [row] = await dataSource.query<{ secretSealed: string }[]>(
        `SELECT "secretSealed" FROM mfa_factors WHERE "userId" = $1`,
        [user.id],
      );
      expect(row.secretSealed.startsWith('v1.')).toBe(true);
      expect(row.secretSealed).not.toContain(secret);
    });

    it('asks for a second factor at login instead of starting a session', async () => {
      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      expect(cookiesFrom(response).access_token).toBeUndefined();
      const data = (
        response.body as Data<{ mfaRequired: boolean; mfaToken: string }>
      ).data;
      expect(data.mfaRequired).toBe(true);

      const wrong = await http()
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: data.mfaToken, code: '000000' })
        .expect(401);
      expect((wrong.body as ErrorBody).error.code).toBe('INVALID_MFA_CODE');

      // The confirm step used the current period's code; the next period's
      // is a fresh, never-used code.
      const ok = await http()
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: data.mfaToken, code: codeFor(secret, 1) })
        .expect(200);
      expect(cookiesFrom(ok).access_token).toBeDefined();
      expect((ok.body as Data<{ email: string }>).data.email).toBe(user.email);

      // A completed challenge can't be reused.
      await http()
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken: data.mfaToken, code: codeFor(secret, 1) })
        .expect(401);
    });

    it('never accepts the same TOTP code twice', async () => {
      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      const { mfaToken } = (response.body as Data<{ mfaToken: string }>).data;
      const replay = await http()
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken, code: codeFor(secret, 1) })
        .expect(401);
      expect((replay.body as ErrorBody).error.code).toBe('INVALID_MFA_CODE');
    });

    it('accepts each recovery code exactly once', async () => {
      const verifyWith = async (recoveryCode: string): Promise<number> => {
        const loginResponse = await http()
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: PASSWORD })
          .expect(200);
        const { mfaToken } = (loginResponse.body as Data<{ mfaToken: string }>)
          .data;
        const r = await http()
          .post('/api/v1/auth/mfa/verify')
          .send({ mfaToken, recoveryCode });
        return r.status;
      };
      // Formatting is forgiving (case, dashes).
      expect(await verifyWith(recoveryCodes[0].toUpperCase())).toBe(200);
      expect(await verifyWith(recoveryCodes[0])).toBe(401);
    });

    it('burns a challenge after too many wrong codes', async () => {
      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      const { mfaToken } = (response.body as Data<{ mfaToken: string }>).data;
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/api/v1/auth/mfa/verify')
          .send({ mfaToken, code: '111111' })
          .expect(401);
      }
      const locked = await http()
        .post('/api/v1/auth/mfa/verify')
        .send({ mfaToken, code: codeFor(secret, 0) })
        .expect(401);
      expect((locked.body as ErrorBody).error.code).toBe(
        'INVALID_MFA_CHALLENGE',
      );
    });

    it('requires the 2FA code (not just the password) to step up', async () => {
      const token = jwt.sign({ sub: user.id, role: user.role });
      await http()
        .post('/api/v1/auth/reauth')
        .set('Cookie', asAccess(token))
        .send({ password: PASSWORD })
        .expect(401);
      await http()
        .post('/api/v1/auth/reauth')
        .set('Cookie', asAccess(token))
        .send({ recoveryCode: recoveryCodes[1] })
        .expect(200);
    });

    it('reports status', async () => {
      const token = jwt.sign({ sub: user.id, role: user.role });
      const response = await http()
        .get('/api/v1/auth/mfa')
        .set('Cookie', asAccess(token))
        .expect(200);
      expect(
        (
          response.body as Data<{
            enabled: boolean;
            recoveryCodesRemaining: number;
          }>
        ).data,
      ).toMatchObject({
        enabled: true,
        recoveryCodesRemaining: 8,
      });
    });
  });

  describe('mandatory 2FA for admins', () => {
    it('blocks admin routes after the grace period but keeps enrolment routes open', async () => {
      const admin = await makeUser('late-admin', {
        role: UserRole.ADMIN,
        adminPermissions: [AdminPermission.OPS],
        mfaRequiredSince: new Date(Date.now() - 15 * 86_400_000),
      });
      const cookie = asAccess(
        jwt.sign({ sub: admin.id, role: UserRole.ADMIN }),
      );

      const blocked = await http()
        .get('/api/v1/admin/approvals')
        .set('Cookie', cookie)
        .expect(403);
      expect((blocked.body as ErrorBody).error.code).toBe(
        'MFA_ENROLLMENT_REQUIRED',
      );

      await http().get('/api/v1/users/me').set('Cookie', cookie).expect(200);
      const status = await http()
        .get('/api/v1/auth/mfa')
        .set('Cookie', cookie)
        .expect(200);
      expect((status.body as Data<{ required: boolean }>).data.required).toBe(
        true,
      );
    });

    it('lets admins work during the grace period', async () => {
      const admin = await makeUser('new-admin', {
        role: UserRole.ADMIN,
        adminPermissions: [AdminPermission.OPS],
        mfaRequiredSince: new Date(),
      });
      const cookie = asAccess(
        jwt.sign({ sub: admin.id, role: UserRole.ADMIN }),
      );
      await http()
        .get('/api/v1/admin/approvals')
        .set('Cookie', cookie)
        .expect(200);
    });

    it('does not let an admin turn 2FA off', async () => {
      const admin = await makeUser('stuck-admin', {
        role: UserRole.ADMIN,
        mfaRequiredSince: new Date(),
      });
      const now = Math.floor(Date.now() / 1000);
      const cookie = asAccess(
        jwt.sign({ sub: admin.id, role: UserRole.ADMIN, reauthAt: now }),
      );
      const response = await http()
        .delete('/api/v1/auth/mfa')
        .set('Cookie', cookie)
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe(
        'MFA_REQUIRED_FOR_ROLE',
      );
    });
  });

  describe('email verification resend', () => {
    it('sends a new link for an unverified account and refuses once verified', async () => {
      const unverified = await makeUser('unverified', {
        emailVerifiedAt: null,
      });
      const cookie = asAccess(
        jwt.sign({ sub: unverified.id, role: unverified.role }),
      );
      await http()
        .post('/api/v1/auth/verify-email/resend')
        .set('Cookie', cookie)
        .expect(200);
      const [{ count }] = await dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*) AS count FROM email_verification_tokens WHERE "userId" = $1 AND "usedAt" IS NULL`,
        [unverified.id],
      );
      expect(Number(count)).toBe(1);

      const verified = await makeUser('verified');
      const response = await http()
        .post('/api/v1/auth/verify-email/resend')
        .set(
          'Cookie',
          asAccess(jwt.sign({ sub: verified.id, role: verified.role })),
        )
        .expect(409);
      expect((response.body as ErrorBody).error.code).toBe(
        'EMAIL_ALREADY_VERIFIED',
      );
    });
  });
});
