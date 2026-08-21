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
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { RiderStatus } from '../../src/modules/riders/domain/rider-status.enum';
import { RiderProfileEntity } from '../../src/modules/riders/infrastructure/entities/rider-profile.entity';

interface SuccessBody {
  success: true;
  data: {
    riders: { riderId: string; storedCount: number; expectedCount: number }[];
    nodes: { nodeId: string; storedCount: number; expectedCount: number }[];
  };
}

describe('Admin capacity audit (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let riderProfiles: Repository<RiderProfileEntity>;
  let nodes: Repository<NodeEntity>;
  let jwtService: JwtService;
  let adminCookie: string;

  const emailPattern = '%@capacity-audit.e2e.test';
  const nodeNamePattern = 'capacity-audit.e2e.test%';
  const password = 'Correct-Horse-Battery-1';

  function asAdmin(req: request.Test): request.Test {
    return req.set('Cookie', [adminCookie]);
  }

  async function createRiderWithCount(
    email: string,
    currentActiveOrderCount: number,
  ): Promise<string> {
    const user = await users.save(
      users.create({
        email,
        passwordHash: await hashPassword(password),
        firstName: 'Rider',
        lastName: 'Tester',
        phone: '+2348012345678',
        role: UserRole.RIDER,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
      }),
    );
    await riderProfiles.save(
      riderProfiles.create({
        userId: user.id,
        currentEmployer: 'Test Dispatch Co',
        licenseNumber: 'ABJ-0000000',
        status: RiderStatus.ACTIVE,
        currentActiveOrderCount,
      }),
    );
    return user.id;
  }

  // Nodes must be created through the real endpoint, not a direct repo
  // save — NodeEntity.location (PostGIS, NOT NULL) is deliberately not
  // TypeORM-mapped and is only ever written via raw SQL inside
  // NodesService.create(), so a plain repo insert violates that column's
  // constraint. currentCount is then patched directly since the API has no
  // (and shouldn't have) a way to set it other than through real
  // reservations.
  async function createNodeWithCount(
    name: string,
    currentCount: number,
  ): Promise<string> {
    const response = await asAdmin(
      request(app.getHttpServer()).post('/api/v1/nodes'),
    )
      .send({
        name: `${nodeNamePattern.replace('%', '')}${name}`,
        address: '1 Test Avenue',
        city: 'Lagos',
        state: 'Lagos',
        latitude: 6.45,
        longitude: 3.47,
        capacity: 30,
      })
      .expect(201);
    const nodeId = (response.body as { data: { id: string } }).data.id;
    await nodes.update(nodeId, { currentCount });
    return nodeId;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    riderProfiles = moduleFixture.get(getRepositoryToken(RiderProfileEntity));
    nodes = moduleFixture.get(getRepositoryToken(NodeEntity));
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@capacity-audit.e2e.test',
        passwordHash: await hashPassword(password),
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
    try {
      await nodes
        .createQueryBuilder()
        .delete()
        .where('name LIKE :pattern', { pattern: nodeNamePattern })
        .execute();
      // rider_profiles cascade-deletes with its user, no explicit cleanup.
      await users
        .createQueryBuilder()
        .delete()
        .where('email LIKE :pattern', { pattern: emailPattern })
        .execute();
    } finally {
      await app.close();
    }
  });

  it('reports a rider whose stored count disagrees with their actual orders', async () => {
    const riderId = await createRiderWithCount(
      'drifted-rider@capacity-audit.e2e.test',
      5,
    );

    const response = await asAdmin(
      request(app.getHttpServer()).get('/api/v1/admin/capacity-audit'),
    ).expect(200);

    const data = (response.body as SuccessBody).data;
    const entry = data.riders.find((row) => row.riderId === riderId);
    expect(entry).toBeDefined();
    expect(entry?.storedCount).toBe(5);
    expect(entry?.expectedCount).toBe(0);
  });

  it('does not report a rider whose stored count matches reality (0 orders, count 0)', async () => {
    const riderId = await createRiderWithCount(
      'synced-rider@capacity-audit.e2e.test',
      0,
    );

    const response = await asAdmin(
      request(app.getHttpServer()).get('/api/v1/admin/capacity-audit'),
    ).expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.riders.some((row) => row.riderId === riderId)).toBe(false);
  });

  it('reports a Node whose stored capacity count disagrees with actual reservations', async () => {
    const nodeId = await createNodeWithCount('drifted', 7);

    const response = await asAdmin(
      request(app.getHttpServer()).get('/api/v1/admin/capacity-audit'),
    ).expect(200);

    const data = (response.body as SuccessBody).data;
    const entry = data.nodes.find((row) => row.nodeId === nodeId);
    expect(entry).toBeDefined();
    expect(entry?.storedCount).toBe(7);
    expect(entry?.expectedCount).toBe(0);
  });

  it('does not report a Node whose stored count matches reality (0 reservations, count 0)', async () => {
    const nodeId = await createNodeWithCount('synced', 0);

    const response = await asAdmin(
      request(app.getHttpServer()).get('/api/v1/admin/capacity-audit'),
    ).expect(200);

    const data = (response.body as SuccessBody).data;
    expect(data.nodes.some((row) => row.nodeId === nodeId)).toBe(false);
  });

  it('rejects a non-Admin role', async () => {
    const riderCookie = `access_token=${jwtService.sign({
      sub: 'some-rider-id',
      role: UserRole.RIDER,
    })}`;

    await request(app.getHttpServer())
      .get('/api/v1/admin/capacity-audit')
      .set('Cookie', [riderCookie])
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/capacity-audit')
      .expect(401);
  });
});
