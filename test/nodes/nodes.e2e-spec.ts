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
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

describe('Nodes (e2e)', () => {
  let app: INestApplication<App>;
  let nodes: Repository<NodeEntity>;
  let jwtService: JwtService;
  let adminCookie: string;
  let consumerCookie: string;

  const namePrefix = 'nodes.e2e.test';

  function baseNodePayload(
    name: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      name: `${namePrefix} ${name}`,
      address: '1 Test Avenue',
      city: 'Lagos',
      state: 'Lagos',
      latitude: 6.45,
      longitude: 3.47,
      capacity: 50,
      ...overrides,
    };
  }

  function asAdmin(req: request.Test): request.Test {
    return req.set('Cookie', [adminCookie]);
  }

  function asConsumer(req: request.Test): request.Test {
    return req.set('Cookie', [consumerCookie]);
  }

  async function createActiveNode(
    name: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await asAdmin(
      request(app.getHttpServer()).post('/api/v1/nodes'),
    )
      .send(baseNodePayload(name, overrides))
      .expect(201);
    return (response.body as SuccessBody).data.id as string;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    nodes = moduleFixture.get(getRepositoryToken(NodeEntity));
    jwtService = moduleFixture.get(JwtService);

    adminCookie = `access_token=${jwtService.sign({ sub: 'admin-id', role: UserRole.ADMIN })}`;
    consumerCookie = `access_token=${jwtService.sign({ sub: 'consumer-id', role: UserRole.CONSUMER })}`;
  });

  afterAll(async () => {
    await nodes
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: `${namePrefix}%` })
      .execute();
    await app.close();
  });

  describe('POST /nodes', () => {
    it('rejects an unauthenticated create', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/nodes')
        .send(baseNodePayload('unauth'))
        .expect(401);

      expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a non-admin create', async () => {
      const response = await asConsumer(
        request(app.getHttpServer()).post('/api/v1/nodes'),
      )
        .send(baseNodePayload('non-admin'))
        .expect(403);

      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('rejects onboardingType=portal on an admin-initiated create', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).post('/api/v1/nodes'),
      )
        .send(baseNodePayload('portal-reject', { onboardingType: 'portal' }))
        .expect(400);

      expect((response.body as ErrorBody).error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an out-of-range latitude', async () => {
      await asAdmin(request(app.getHttpServer()).post('/api/v1/nodes'))
        .send(baseNodePayload('bad-lat', { latitude: 200 }))
        .expect(400);
    });

    it('creates a Node that defaults to active status and field_recruited onboarding', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).post('/api/v1/nodes'),
      )
        .send(baseNodePayload('happy-path'))
        .expect(201);

      const data = (response.body as SuccessBody).data;
      expect(data.status).toBe('active');
      expect(data.onboardingType).toBe('field_recruited');
      expect(data.capacity).toBe(50);

      const stored = await nodes.findOneByOrFail({ id: data.id as string });
      expect(stored.latitude).toBeCloseTo(6.45);
      expect(stored.longitude).toBeCloseTo(3.47);
    });
  });

  describe('GET /nodes and /nodes/:id — visibility', () => {
    let pendingNodeId: string;
    let activeNodeId: string;

    beforeAll(async () => {
      activeNodeId = await createActiveNode('visibility-active');

      pendingNodeId = await createActiveNode('visibility-pending', {
        latitude: 6.46,
        longitude: 3.48,
      });
      await nodes.update({ id: pendingNodeId }, { status: 'pending' as never });
    });

    it('excludes pending Nodes from a non-admin list, even with a status filter', async () => {
      const response = await asConsumer(
        request(app.getHttpServer()).get(
          '/api/v1/nodes?status=pending&limit=100',
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string }[];
      };
      expect(data.items.some((n) => n.id === pendingNodeId)).toBe(false);
      expect(data.items.some((n) => n.id === activeNodeId)).toBe(true);
    });

    it('lets an admin filter the list by status', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).get(
          '/api/v1/nodes?status=pending&limit=100',
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string }[];
        total: number;
      };
      expect(data.items.some((n) => n.id === pendingNodeId)).toBe(true);
    });

    it('hides a pending Node from a non-admin GET /nodes/:id (404, not 403)', async () => {
      const response = await asConsumer(
        request(app.getHttpServer()).get(`/api/v1/nodes/${pendingNodeId}`),
      ).expect(404);

      expect((response.body as ErrorBody).error.code).toBe('NOT_FOUND');
    });

    it('lets an admin GET a pending Node by id', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(`/api/v1/nodes/${pendingNodeId}`),
      ).expect(200);
    });

    it('returns 404 for a well-formed but non-existent id', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(
          '/api/v1/nodes/00000000-0000-0000-0000-000000000000',
        ),
      ).expect(404);
    });

    it('returns 400 for a malformed id', async () => {
      await asAdmin(
        request(app.getHttpServer()).get('/api/v1/nodes/not-a-uuid'),
      ).expect(400);
    });
  });

  describe('PATCH /nodes/:id', () => {
    it('rejects a non-admin update', async () => {
      const id = await createActiveNode('patch-non-admin');
      const response = await asConsumer(
        request(app.getHttpServer()).patch(`/api/v1/nodes/${id}`),
      )
        .send({ capacity: 999 })
        .expect(403);

      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('updates fields and transitions status', async () => {
      const id = await createActiveNode('patch-happy-path');

      const response = await asAdmin(
        request(app.getHttpServer()).patch(`/api/v1/nodes/${id}`),
      )
        .send({ capacity: 200, status: 'suspended' })
        .expect(200);

      const data = (response.body as SuccessBody).data;
      expect(data.capacity).toBe(200);
      expect(data.status).toBe('suspended');
    });

    it('re-syncs the spatial location when latitude/longitude change', async () => {
      const id = await createActiveNode('patch-relocate', {
        latitude: 6.45,
        longitude: 3.47,
      });

      await asAdmin(request(app.getHttpServer()).patch(`/api/v1/nodes/${id}`))
        .send({ latitude: 6.6, longitude: 3.35 })
        .expect(200);

      // Far outside a tight radius around the original coordinates.
      const nearbyOriginal = await asAdmin(
        request(app.getHttpServer()).get(
          '/api/v1/nodes/nearby?latitude=6.45&longitude=3.47&radiusKm=1',
        ),
      ).expect(200);
      const originalData = (nearbyOriginal.body as SuccessBody).data as {
        items: { id: string }[];
      };
      expect(originalData.items.some((n) => n.id === id)).toBe(false);

      const nearbyRelocated = await asAdmin(
        request(app.getHttpServer()).get(
          '/api/v1/nodes/nearby?latitude=6.6&longitude=3.35&radiusKm=1',
        ),
      ).expect(200);
      const relocatedData = (nearbyRelocated.body as SuccessBody).data as {
        items: { id: string }[];
      };
      expect(relocatedData.items.some((n) => n.id === id)).toBe(true);
    });

    it('returns 404 updating a non-existent Node', async () => {
      await asAdmin(
        request(app.getHttpServer()).patch(
          '/api/v1/nodes/00000000-0000-0000-0000-000000000000',
        ),
      )
        .send({ capacity: 10 })
        .expect(404);
    });
  });

  describe('GET /nodes/nearby', () => {
    let closeId: string;
    let midId: string;
    let farId: string;
    let suspendedId: string;

    beforeAll(async () => {
      closeId = await createActiveNode('nearby-close', {
        latitude: 6.45,
        longitude: 3.47,
      });
      midId = await createActiveNode('nearby-mid', {
        latitude: 6.452,
        longitude: 3.472,
      });
      farId = await createActiveNode('nearby-far', {
        latitude: 6.6,
        longitude: 3.35,
      });
      suspendedId = await createActiveNode('nearby-suspended', {
        latitude: 6.4501,
        longitude: 3.4701,
      });
      await asAdmin(
        request(app.getHttpServer()).patch(`/api/v1/nodes/${suspendedId}`),
      )
        .send({ status: 'suspended' })
        .expect(200);
    });

    it('returns only active Nodes within the radius, ordered by distance', async () => {
      const response = await asConsumer(
        request(app.getHttpServer()).get(
          '/api/v1/nodes/nearby?latitude=6.45&longitude=3.47&radiusKm=1',
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: { id: string; distanceMeters: number }[];
      };
      const ids = data.items.map((n) => n.id);
      expect(ids).toContain(closeId);
      expect(ids).toContain(midId);
      expect(ids).not.toContain(farId);
      expect(ids).not.toContain(suspendedId);

      const closeIndex = ids.indexOf(closeId);
      const midIndex = ids.indexOf(midId);
      expect(closeIndex).toBeLessThan(midIndex);
    });

    it('rejects a request missing required lat/lng/radius params', async () => {
      await asConsumer(
        request(app.getHttpServer()).get('/api/v1/nodes/nearby'),
      ).expect(400);
    });
  });

  describe('pagination', () => {
    it('honors page/limit and reports total', async () => {
      const prefix = 'pagination';
      for (let i = 0; i < 3; i++) {
        await createActiveNode(`${prefix}-${i}`, {
          latitude: 6.5 + i * 0.01,
          longitude: 3.5 + i * 0.01,
        });
      }

      const response = await asAdmin(
        request(app.getHttpServer()).get('/api/v1/nodes?page=1&limit=2'),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: unknown[];
        page: number;
        limit: number;
        total: number;
      };
      expect(data.items.length).toBe(2);
      expect(data.page).toBe(1);
      expect(data.limit).toBe(2);
      expect(data.total).toBeGreaterThanOrEqual(3);
    });

    it('rejects a limit above the max', async () => {
      await asAdmin(
        request(app.getHttpServer()).get('/api/v1/nodes?limit=1000'),
      ).expect(400);
    });
  });
});
