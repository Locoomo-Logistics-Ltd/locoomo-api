import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { UserRole } from '../../src/common/auth/user-role.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { NodeOperatorProfileEntity } from '../../src/modules/node-operators/infrastructure/entities/node-operator-profile.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

describe('Node-operators (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let profiles: Repository<NodeOperatorProfileEntity>;
  let nodes: Repository<NodeEntity>;
  let jwtService: JwtService;
  let adminCookie: string;

  const emailPattern = '%@node-operators.e2e.test';
  const nodeNamePattern = 'node-operators.e2e.test%';
  const password = 'Correct-Horse-Battery-1';

  function onboardPayload(
    name: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      name: `node-operators.e2e.test ${name}`,
      address: '1 Test Avenue',
      city: 'Lagos',
      state: 'Lagos',
      latitude: 6.45,
      longitude: 3.47,
      capacity: 30,
      ...overrides,
    };
  }

  async function registerNodeOperator(email: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Operator',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.NODE_OPERATOR,
      })
      .expect(201);
  }

  async function loginCookie(email: string): Promise<string> {
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
    profiles = moduleFixture.get(getRepositoryToken(NodeOperatorProfileEntity));
    nodes = moduleFixture.get(getRepositoryToken(NodeEntity));
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@node-operators.e2e.test',
        passwordHash: await hashPassword('Correct-Horse-Battery-1'),
        firstName: 'Admin',
        lastName: 'Tester',
        phone: '+2348012345678',
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
      }),
    );
    const adminToken = jwtService.sign({ sub: admin.id, role: UserRole.ADMIN });
    adminCookie = `access_token=${adminToken}`;
  });

  afterAll(async () => {
    await users
      .createQueryBuilder()
      .delete()
      .where('email LIKE :pattern', { pattern: emailPattern })
      .execute();
    await nodes
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: nodeNamePattern })
      .execute();
    await app.close();
  });

  it('self-registers a NodeOperator into pending_review status, able to log in immediately', async () => {
    const email = 'register-happy-path@node-operators.e2e.test';
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Operator',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.NODE_OPERATOR,
      })
      .expect(201);

    const data = (response.body as SuccessBody).data;
    expect(data.role).toBe('node_operator');
    expect(data.status).toBe('pending_review');

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
  });

  it('rejects self-registering as admin', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Nope',
        lastName: 'Tester',
        email: 'admin-reject@node-operators.e2e.test',
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.ADMIN,
      })
      .expect(400);
    expect((response.body as ErrorBody).error.code).toBe('VALIDATION_FAILED');
  });

  describe('onboarding', () => {
    const email = 'onboard-happy-path@node-operators.e2e.test';
    let operatorCookie: string;

    beforeAll(async () => {
      await registerNodeOperator(email);
      operatorCookie = await loginCookie(email);
    });

    it('rejects an unauthenticated onboarding attempt', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .send(onboardPayload('unauth'))
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects onboarding from a non-NodeOperator role', async () => {
      const consumerToken = jwtService.sign({
        sub: 'some-consumer-id',
        role: UserRole.CONSUMER,
      });
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [`access_token=${consumerToken}`])
        .send(onboardPayload('wrong-role'))
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('rejects an invalid payload (out-of-range latitude)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('bad-lat', { latitude: 200 }))
        .expect(400);
    });

    it('creates a pending, portal-onboarded Node tied to the operator', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('happy-path'))
        .expect(201);

      const data = (response.body as SuccessBody).data as {
        profileId: string;
        node: { status: string; onboardingType: string };
      };
      expect(data.node.status).toBe('pending');
      expect(data.node.onboardingType).toBe('portal');

      const user = await users.findOneByOrFail({ email });
      const profile = await profiles.findOneByOrFail({ userId: user.id });
      expect(profile.id).toBe(data.profileId);
    });

    it('returns the same profile via GET /node-operators/me', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/node-operators/me')
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        node: { status: string };
      };
      expect(data.node.status).toBe('pending');
    });

    it('rejects a second onboarding attempt from the same operator', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('second-attempt'))
        .expect(409);
      expect((response.body as ErrorBody).error.code).toBe(
        'NODE_OPERATOR_ALREADY_ONBOARDED',
      );
    });
  });

  describe('admin review queue and approval', () => {
    const email = 'approval-flow@node-operators.e2e.test';
    let operatorCookie: string;
    let profileId: string;
    let nodeId: string;

    beforeAll(async () => {
      await registerNodeOperator(email);
      operatorCookie = await loginCookie(email);

      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('approval-flow'))
        .expect(201);

      const data = (response.body as SuccessBody).data as {
        profileId: string;
        node: { id: string };
      };
      profileId = data.profileId;
      nodeId = data.node.id;
    });

    it('rejects a non-admin listing the pending queue', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/node-operators/pending')
        .set('Cookie', [operatorCookie])
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('lists the operator in the Admin pending queue', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/node-operators/pending?limit=100')
        .set('Cookie', [adminCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { profileId: string; userEmail: string }[];
      };
      expect(
        data.items.some(
          (i) => i.profileId === profileId && i.userEmail === email,
        ),
      ).toBe(true);
    });

    it('rejects a non-admin approval', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/${profileId}/approve`)
        .set('Cookie', [operatorCookie])
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('returns 404 approving a non-existent profile', async () => {
      await request(app.getHttpServer())
        .patch(
          '/api/v1/node-operators/00000000-0000-0000-0000-000000000000/approve',
        )
        .set('Cookie', [adminCookie])
        .expect(404);
    });

    it('approves the operator, activating both the User and the Node together', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/${profileId}/approve`)
        .set('Cookie', [adminCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        node: { status: string };
      };
      expect(data.node.status).toBe('active');

      const user = await users.findOneByOrFail({ email });
      expect(user.status).toBe(UserStatus.ACTIVE);

      const node = await nodes.findOneByOrFail({ id: nodeId });
      expect(node.status).toBe('active');
    });

    it('no longer appears in the pending queue after approval', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/node-operators/pending?limit=100')
        .set('Cookie', [adminCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { profileId: string }[];
      };
      expect(data.items.some((i) => i.profileId === profileId)).toBe(false);
    });

    it('the now-active Node shows up in GET /nodes for any authenticated role', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/nodes/${nodeId}`)
        .set('Cookie', [operatorCookie])
        .expect(200);
      const data = (response.body as SuccessBody).data as { status: string };
      expect(data.status).toBe('active');
    });
  });
});
