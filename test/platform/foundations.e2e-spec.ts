import {
  Body,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  OnModuleInit,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { AdminPermission } from '../../src/common/auth/admin-permission.enum';
import { ApiKeyAuthenticatorRegistry } from '../../src/common/auth/api-key-authenticator.registry';
import { AllowApiKey } from '../../src/common/auth/decorators/allow-api-key.decorator';
import { CurrentPrincipal } from '../../src/common/auth/decorators/current-principal.decorator';
import type { Principal } from '../../src/common/auth/principal';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { AuditEventEntity } from '../../src/common/audit/audit-event.entity';
import { IdempotencyInterceptor } from '../../src/common/idempotency/idempotency.interceptor';
import { IdempotencyModule } from '../../src/common/idempotency/idempotency.module';
import {
  IsPhoneE164,
  NormalizePhone,
} from '../../src/common/phone/phone-number';
import { AdminModule } from '../../src/modules/admin/admin.module';
import { ApprovalActionRegistry } from '../../src/modules/admin/application/approval-action.registry';
import { ApprovalService } from '../../src/modules/admin/application/approval.service';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';

// ── Test-only surface ────────────────────────────────────────────────────

const VALID_SK = 'sk_test_' + 'a'.repeat(32);
const LIMITED_SK = 'sk_test_' + 'b'.repeat(32);
const UNKNOWN_SK = 'sk_test_' + 'c'.repeat(32);

class ReceiverDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @NormalizePhone()
  @IsPhoneE164()
  phone!: string;
}

class CreateThingDto {
  @IsInt()
  amount!: number;

  @ValidateNested()
  @Type(() => ReceiverDto)
  receiver!: ReceiverDto;
}

let handlerCalls = 0;
let approvalExecutions = 0;

@Controller('foundations-test')
class FoundationsTestController {
  @Get('cookie-only')
  cookieOnly(): { ok: true } {
    return { ok: true };
  }

  @Get('keyed')
  @AllowApiKey('things:read')
  keyed(@CurrentPrincipal() principal: Principal): Principal {
    return principal;
  }

  @Post('things')
  @AllowApiKey('things:write')
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateThingDto): { n: number; amount: number } {
    handlerCalls += 1;
    return { n: handlerCalls, amount: dto.amount };
  }
}

@Injectable()
class FoundationsTestSetup implements OnModuleInit {
  constructor(
    private readonly keys: ApiKeyAuthenticatorRegistry,
    private readonly approvals: ApprovalActionRegistry,
  ) {}

  onModuleInit(): void {
    this.keys.register({
      authenticate: (raw) => {
        const base = {
          kind: 'api_key' as const,
          keyKind: 'secret' as const,
          merchantId: '00000000-0000-4000-8000-000000000001',
          mode: 'test' as const,
        };
        if (raw === VALID_SK) {
          return Promise.resolve({
            ...base,
            keyId: 'key-full',
            scopes: ['things:read', 'things:write'],
          });
        }
        if (raw === LIMITED_SK) {
          return Promise.resolve({
            ...base,
            keyId: 'key-limited',
            scopes: ['things:read'],
          });
        }
        return Promise.resolve(null);
      },
    });
    this.approvals.register('foundations.test_payout', {
      permission: AdminPermission.FINANCE,
      prepare: (payload) =>
        Promise.resolve({
          payload,
          summary: `Test payout of ${String(payload.amount)}`,
        }),
      execute: () => {
        approvalExecutions += 1;
        return Promise.resolve({ executed: true });
      },
    });
  }
}

@Module({
  imports: [IdempotencyModule, AdminModule],
  controllers: [FoundationsTestController],
  providers: [FoundationsTestSetup],
})
class FoundationsTestModule {}

// ── Suite ────────────────────────────────────────────────────────────────

interface ErrorBody {
  success: false;
  error: {
    code: string;
    details?: { field: string; constraint: string }[];
  };
}

describe('Platform foundations (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let audit: Repository<AuditEventEntity>;
  let jwt: JwtService;
  let dataSource: DataSource;

  const emailPattern = '%@foundations.e2e.test';
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  async function makeAdmin(
    name: string,
    permissions: AdminPermission[],
  ): Promise<void> {
    const user = await users.save(
      users.create({
        email: `${name}@foundations.e2e.test`,
        passwordHash: await hashPassword('Correct-Horse-Battery-1'),
        firstName: name,
        lastName: 'Admin',
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        adminPermissions: permissions,
        consentAcceptedAt: new Date(),
      }),
    );
    ids[name] = user.id;
    cookies[name] =
      `access_token=${jwt.sign({ sub: user.id, role: UserRole.ADMIN })}`;
  }

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, FoundationsTestModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    audit = moduleFixture.get(getRepositoryToken(AuditEventEntity));
    jwt = moduleFixture.get(JwtService);
    dataSource = moduleFixture.get(DataSource);

    await makeAdmin('super1', [AdminPermission.SUPER]);
    await makeAdmin('finance1', [AdminPermission.FINANCE]);
    await makeAdmin('finance2', [AdminPermission.FINANCE]);
    await makeAdmin('ops1', [AdminPermission.OPS]);
  });

  afterAll(async () => {
    try {
      const userIds = Object.values(ids);
      if (userIds.length) {
        await dataSource.query(
          `DELETE FROM approval_requests WHERE "requestedByUserId" = ANY($1)`,
          [userIds],
        );
        await dataSource.query(
          `DELETE FROM audit_events WHERE "actorId" = ANY($1) OR "targetId" = ANY($2)`,
          [userIds, userIds],
        );
      }
      await dataSource.query(
        `DELETE FROM idempotency_keys WHERE scope LIKE 'http:merchant:00000000-0000-4000-8000-000000000001:%'`,
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

  describe('HTTP hardening', () => {
    it('sends security headers on every response', async () => {
      const response = await http().get('/api/v1/foundations-test/cookie-only');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    });

    it('accepts JSON bodies above the old 100kb default', async () => {
      const big = {
        amount: 1,
        receiver: { name: 'x'.repeat(200_000), phone: '08031234567' },
      };
      await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .send(big)
        .expect(201);
    });

    it('rejects bodies over 1mb with 413 in the standard error envelope', async () => {
      const huge = {
        amount: 1,
        receiver: { name: 'x'.repeat(1_100_000), phone: '08031234567' },
      };
      const response = await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .send(huge)
        .expect(413);
      expect((response.body as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects malformed JSON with 400 in the standard error envelope', async () => {
      const response = await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .set('Content-Type', 'application/json')
        .send('{"amount": 1,')
        .expect(400);
      expect((response.body as ErrorBody).error.code).toBe('MALFORMED_JSON');
    });

    it('lets a cookie-authenticated mutation through in CSRF report mode', async () => {
      // CSRF_MODE defaults to `report` — logged, not blocked (enforce is
      // covered by csrf.guard.spec.ts).
      await http()
        .post(
          '/api/v1/admin/approvals/00000000-0000-4000-8000-000000000999/cancel',
        )
        .set('Cookie', [cookies.super1])
        .expect(404);
    });
  });

  describe('nested validation errors', () => {
    it('reports the full path of a nested field', async () => {
      const response = await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .send({ amount: 1, receiver: { name: 'Ada', phone: 'not a phone' } })
        .expect(400);
      const details = (response.body as ErrorBody).error.details ?? [];
      expect(details.map((d) => d.field)).toContain('receiver.phone');
    });
  });

  describe('API keys', () => {
    it('rejects a key on a route that did not opt in, like no credentials at all', async () => {
      const response = await http()
        .get('/api/v1/foundations-test/cookie-only')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects an unknown key with a uniform INVALID_API_KEY', async () => {
      const response = await http()
        .get('/api/v1/foundations-test/keyed')
        .set('Authorization', `Bearer ${UNKNOWN_SK}`)
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe('INVALID_API_KEY');
    });

    it('rejects a valid key that lacks the route scope', async () => {
      const response = await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${LIMITED_SK}`)
        .send({ amount: 1, receiver: { name: 'Ada', phone: '08031234567' } })
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe(
        'INSUFFICIENT_SCOPE',
      );
    });

    it('exposes the key principal to the handler', async () => {
      const response = await http()
        .get('/api/v1/foundations-test/keyed')
        .set('Authorization', `Bearer ${LIMITED_SK}`)
        .expect(200);
      expect((response.body as { data: Principal }).data).toMatchObject({
        kind: 'api_key',
        keyId: 'key-limited',
        mode: 'test',
      });
    });

    it('never lets a key reach role-gated routes', async () => {
      await http()
        .get('/api/v1/admin/approvals')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .expect(401);
    });
  });

  describe('Idempotency-Key', () => {
    const body = { amount: 7, receiver: { name: 'Ada', phone: '08031234567' } };

    it('replays the stored response for a retried request without re-running it', async () => {
      const first = await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .set('Idempotency-Key', 'idem-replay-1')
        .send(body)
        .expect(201);
      const callsAfterFirst = handlerCalls;

      const second = await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .set('Idempotency-Key', 'idem-replay-1')
        // Same content, different key order — still the same request.
        .send({ receiver: { phone: '08031234567', name: 'Ada' }, amount: 7 })
        .expect(201);

      expect(handlerCalls).toBe(callsAfterFirst);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect((second.body as { data: unknown }).data).toEqual(
        (first.body as { data: unknown }).data,
      );
    });

    it('rejects the same key reused for a different request', async () => {
      const response = await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .set('Idempotency-Key', 'idem-replay-1')
        .send({ ...body, amount: 8 })
        .expect(422);
      expect((response.body as ErrorBody).error.code).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('does not cache failures — the same key can be retried after a 400', async () => {
      await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .set('Idempotency-Key', 'idem-after-error')
        .send({ amount: 'nope' })
        .expect(400);
      await http()
        .post('/api/v1/foundations-test/things')
        .set('Authorization', `Bearer ${VALID_SK}`)
        .set('Idempotency-Key', 'idem-after-error')
        .send(body)
        .expect(201);
    });

    it('processes every request when no key is sent', async () => {
      const before = handlerCalls;
      for (let i = 0; i < 2; i++) {
        await http()
          .post('/api/v1/foundations-test/things')
          .set('Authorization', `Bearer ${VALID_SK}`)
          .send(body)
          .expect(201);
      }
      expect(handlerCalls).toBe(before + 2);
    });
  });

  describe('admin permissions', () => {
    it('lets a super admin change another admin’s permissions, and audits it', async () => {
      const response = await http()
        .patch(`/api/v1/admin/admins/${ids.ops1}/permissions`)
        .set('Cookie', [cookies.super1])
        .send({ permissions: [AdminPermission.OPS, AdminPermission.SUPPORT] })
        .expect(200);
      expect(
        (response.body as { data: { adminPermissions: string[] } }).data
          .adminPermissions,
      ).toEqual([AdminPermission.OPS, AdminPermission.SUPPORT]);

      const event = await audit.findOneBy({
        action: 'admin.permissions.updated',
        targetId: ids.ops1,
      });
      expect(event?.actorId).toBe(ids.super1);
    });

    it('forbids a non-super admin from managing permissions', async () => {
      await http()
        .get('/api/v1/admin/admins')
        .set('Cookie', [cookies.finance1])
        .expect(403);
    });

    it('refuses to remove super from the last active super admin', async () => {
      // Every pre-existing admin in this database also holds super (the
      // migration grants it), so demote only after making super1 the only
      // one — scoped to this suite's users via a temporary status flip.
      await dataSource.query(
        `UPDATE users SET status = 'suspended'
          WHERE role = 'admin' AND 'super' = ANY("adminPermissions") AND id <> $1`,
        [ids.super1],
      );
      try {
        const response = await http()
          .patch(`/api/v1/admin/admins/${ids.super1}/permissions`)
          .set('Cookie', [cookies.super1])
          .send({ permissions: [AdminPermission.OPS] })
          .expect(409);
        expect((response.body as ErrorBody).error.code).toBe(
          'LAST_SUPER_ADMIN',
        );
      } finally {
        await dataSource.query(
          `UPDATE users SET status = 'active'
            WHERE role = 'admin' AND 'super' = ANY("adminPermissions") AND id <> $1
              AND status = 'suspended'`,
          [ids.super1],
        );
      }
    });
  });

  describe('maker-checker approvals', () => {
    let approvalId: string;

    beforeAll(async () => {
      const approvals = app.get(ApprovalService);
      const created = await approvals.request({
        action: 'foundations.test_payout',
        payload: { amount: 2500 },
        reason: 'e2e',
        requestedByUserId: ids.finance1,
        context: { ip: null, userAgent: null, correlationId: null },
      });
      approvalId = created.id;
    });

    it('lists the pending request in the queue', async () => {
      const response = await http()
        .get('/api/v1/admin/approvals?status=pending')
        .set('Cookie', [cookies.ops1])
        .expect(200);
      const items = (response.body as { data: { items: { id: string }[] } })
        .data.items;
      expect(items.map((i) => i.id)).toContain(approvalId);
    });

    it('refuses approval by the admin who requested it', async () => {
      const response = await http()
        .post(`/api/v1/admin/approvals/${approvalId}/approve`)
        .set('Cookie', [cookies.finance1])
        .send({})
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe(
        'SELF_APPROVAL_NOT_ALLOWED',
      );
    });

    it('refuses approval by an admin without the action’s permission', async () => {
      await http()
        .post(`/api/v1/admin/approvals/${approvalId}/approve`)
        .set('Cookie', [cookies.ops1])
        .send({})
        .expect(403);
      expect(approvalExecutions).toBe(0);
    });

    it('executes once approved by a second permitted admin, then cannot be approved again', async () => {
      const response = await http()
        .post(`/api/v1/admin/approvals/${approvalId}/approve`)
        .set('Cookie', [cookies.finance2])
        .send({ note: 'checked' })
        .expect(200);
      expect((response.body as { data: { status: string } }).data.status).toBe(
        'executed',
      );
      expect(approvalExecutions).toBe(1);

      const again = await http()
        .post(`/api/v1/admin/approvals/${approvalId}/approve`)
        .set('Cookie', [cookies.super1])
        .send({})
        .expect(409);
      expect((again.body as ErrorBody).error.code).toBe('APPROVAL_NOT_PENDING');
      expect(approvalExecutions).toBe(1);
    });
  });
});
