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
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { BankAccountVerificationFailedException } from '../../src/modules/payments/domain/exceptions/bank-account-verification-failed.exception';
import { PaystackBankService } from '../../src/modules/payments/application/paystack-bank.service';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

interface SuccessListBody {
  success: true;
  data: Record<string, unknown>[];
}

// Fakes the Paystack bank-resolve boundary — accountNumber '0000000000' is
// the reserved "Paystack rejects this" sentinel (mirrors riders.e2e-spec.ts).
class FakePaystackBankService {
  listBanks() {
    return Promise.resolve([{ code: '058', name: 'GTBank' }]);
  }

  resolveAccountNumber(_bankCode: string, accountNumber: string) {
    if (accountNumber === '0000000000') {
      return Promise.reject(
        new BankAccountVerificationFailedException(
          'no account found (fake rejection)',
        ),
      );
    }
    return Promise.resolve({ accountName: `Resolved ${accountNumber}` });
  }
}

describe('Node-operators (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let memberships: Repository<NodeMembershipEntity>;
  let nodes: Repository<NodeEntity>;
  let jwtService: JwtService;
  let fakeBankService: FakePaystackBankService;
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

  // Phone is no longer collected at registration — onboarding hard-gates on
  // it (OnboardNodeService), so any test flow that onboards needs this
  // between loginCookie and the onboarding POST.
  async function completeProfile(cookie: string): Promise<void> {
    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Cookie', [cookie])
      .send({ phone: '+2348012345678' })
      .expect(200);
  }

  beforeAll(async () => {
    fakeBankService = new FakePaystackBankService();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PaystackBankService)
      .useValue(fakeBankService)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    memberships = moduleFixture.get(getRepositoryToken(NodeMembershipEntity));
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
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.NODE_OPERATOR,
      })
      .expect(201);

    const data = (response.body as SuccessBody).data;
    expect(data.role).toBe('node_operator');
    expect(data.status).toBe('pending_review');
    expect(data.phone).toBeNull();

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
      await completeProfile(operatorCookie);
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

    it('creates a pending, portal-onboarded Node tied to the operator as owner', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('happy-path'))
        .expect(201);

      const data = (response.body as SuccessBody).data as {
        profileId: string;
        roleAtNode: string;
        node: { status: string; onboardingType: string };
      };
      expect(data.roleAtNode).toBe('owner');
      expect(data.node.status).toBe('pending');
      expect(data.node.onboardingType).toBe('portal');

      const user = await users.findOneByOrFail({ email });
      const membership = await memberships.findOneByOrFail({
        userId: user.id,
      });
      expect(membership.id).toBe(data.profileId);
      expect(membership.roleAtNode).toBe('owner');
    });

    it('lists the Node via GET /node-operators/me/nodes', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/node-operators/me/nodes')
        .set('Cookie', [operatorCookie])
        .expect(200);

      const data = (response.body as SuccessListBody).data as {
        roleAtNode: string;
        node: { status: string };
      }[];
      expect(data).toHaveLength(1);
      expect(data[0].roleAtNode).toBe('owner');
      expect(data[0].node.status).toBe('pending');
    });

    it('rejects a second /onboarding call once already onboarded', async () => {
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

  describe('adding additional Nodes', () => {
    const email = 'multi-node@node-operators.e2e.test';
    let operatorCookie: string;

    beforeAll(async () => {
      await registerNodeOperator(email);
      operatorCookie = await loginCookie(email);
      await completeProfile(operatorCookie);
    });

    it('rejects POST /node-operators/nodes before completing initial onboarding', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/nodes')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('too-early'))
        .expect(400);
      expect((response.body as ErrorBody).error.code).toBe(
        'NODE_OPERATOR_NOT_ONBOARDED',
      );
    });

    it('adds a second Node once onboarded, both visible via GET /me/nodes', async () => {
      const first = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('first'))
        .expect(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/node-operators/nodes')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('second'))
        .expect(201);

      const firstData = (first.body as SuccessBody).data as {
        node: { id: string };
      };
      const secondData = (second.body as SuccessBody).data as {
        roleAtNode: string;
        node: { id: string };
      };
      expect(secondData.roleAtNode).toBe('owner');
      expect(secondData.node.id).not.toBe(firstData.node.id);

      const listResponse = await request(app.getHttpServer())
        .get('/api/v1/node-operators/me/nodes')
        .set('Cookie', [operatorCookie])
        .expect(200);
      const items = (listResponse.body as SuccessListBody).data as {
        node: { id: string };
      }[];
      expect(items.map((i) => i.node.id).sort()).toEqual(
        [firstData.node.id, secondData.node.id].sort(),
      );
    });
  });

  describe('onboarding requires a completed profile', () => {
    const email = 'profile-incomplete@node-operators.e2e.test';
    let operatorCookie: string;

    beforeAll(async () => {
      await registerNodeOperator(email);
      operatorCookie = await loginCookie(email);
    });

    it('rejects onboarding while phone has not been set', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('incomplete'))
        .expect(400);
      expect((response.body as ErrorBody).error.code).toBe(
        'PROFILE_INCOMPLETE',
      );
    });

    it('succeeds once the profile is completed via PATCH /users/me', async () => {
      await completeProfile(operatorCookie);
      await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('now-complete'))
        .expect(201);
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
      await completeProfile(operatorCookie);

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

    it('a 2nd Node from this already-active operator still appears in the pending queue', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/nodes')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('second-node-after-approval'))
        .expect(201);
      const secondProfileId = (response.body as SuccessBody).data
        .profileId as string;

      const pendingResponse = await request(app.getHttpServer())
        .get('/api/v1/node-operators/pending?limit=100')
        .set('Cookie', [adminCookie])
        .expect(200);
      const items = (pendingResponse.body as SuccessBody).data as {
        items: { profileId: string }[];
      };
      expect(items.items.some((i) => i.profileId === secondProfileId)).toBe(
        true,
      );
    });
  });

  describe('PATCH /node-operators/nodes/:nodeId/payout-account', () => {
    const email = 'payout-account@node-operators.e2e.test';
    let operatorCookie: string;
    let nodeId: string;

    beforeAll(async () => {
      await registerNodeOperator(email);
      operatorCookie = await loginCookie(email);
      await completeProfile(operatorCookie);
      const response = await request(app.getHttpServer())
        .post('/api/v1/node-operators/onboarding')
        .set('Cookie', [operatorCookie])
        .send(onboardPayload('payout-account'))
        .expect(201);
      nodeId = ((response.body as SuccessBody).data as { node: { id: string } })
        .node.id;
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/nodes/${nodeId}/payout-account`)
        .send({
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0123456789',
        })
        .expect(401);
    });

    it('rejects a non-NodeOperator role', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/nodes/${nodeId}/payout-account`)
        .set('Cookie', [adminCookie])
        .send({
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0123456789',
        })
        .expect(403);
    });

    it('404s for a Node the caller does not own', async () => {
      await request(app.getHttpServer())
        .patch(
          '/api/v1/node-operators/nodes/00000000-0000-0000-0000-000000000000/payout-account',
        )
        .set('Cookie', [operatorCookie])
        .send({
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0123456789',
        })
        .expect(404);
    });

    it('rejects an accountNumber that is not exactly 10 digits', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/nodes/${nodeId}/payout-account`)
        .set('Cookie', [operatorCookie])
        .send({ bankCode: '058', bankName: 'GTBank', accountNumber: '123' })
        .expect(400);
    });

    it('verifies and stores the payout account, reflected on GET /me/nodes', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/nodes/${nodeId}/payout-account`)
        .set('Cookie', [operatorCookie])
        .send({
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0123456789',
        })
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        payoutAccountConfigured: boolean;
        payoutBankName: string;
        payoutAccountNumber: string;
        payoutAccountName: string;
      };
      expect(data.payoutAccountConfigured).toBe(true);
      expect(data.payoutBankName).toBe('GTBank');
      expect(data.payoutAccountNumber).toBe('0123456789');
      expect(data.payoutAccountName).toBe('Resolved 0123456789');

      const getResponse = await request(app.getHttpServer())
        .get('/api/v1/node-operators/me/nodes')
        .set('Cookie', [operatorCookie])
        .expect(200);
      const items = (getResponse.body as SuccessListBody).data as {
        node: { id: string };
        payoutAccountConfigured: boolean;
      }[];
      const mine = items.find((i) => i.node.id === nodeId);
      expect(mine?.payoutAccountConfigured).toBe(true);
    });

    it('rejects an account Paystack cannot resolve, leaving the prior verified account untouched', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/node-operators/nodes/${nodeId}/payout-account`)
        .set('Cookie', [operatorCookie])
        .send({
          bankCode: '058',
          bankName: 'GTBank',
          accountNumber: '0000000000',
        })
        .expect(400);
      expect((response.body as ErrorBody).error.code).toBe(
        'BANK_ACCOUNT_VERIFICATION_FAILED',
      );

      const getResponse = await request(app.getHttpServer())
        .get('/api/v1/node-operators/me/nodes')
        .set('Cookie', [operatorCookie])
        .expect(200);
      const items = (getResponse.body as SuccessListBody).data as {
        node: { id: string };
        payoutAccountNumber: string;
      }[];
      const mine = items.find((i) => i.node.id === nodeId);
      expect(mine?.payoutAccountNumber).toBe('0123456789');
    });
  });
});
