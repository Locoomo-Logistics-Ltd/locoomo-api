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
import { UserStatus } from '../../src/modules/identity/domain/user-status.enum';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { NodeMembershipEntity } from '../../src/modules/node-operators/infrastructure/entities/node-membership.entity';
import {
  GeocodeResult,
  Geocoder,
  GeocoderUnavailableError,
} from '../../src/modules/nodes/domain/ports/geocoder.port';
import { NodeEntity } from '../../src/modules/nodes/infrastructure/entities/node.entity';
import { GEOCODER } from '../../src/modules/nodes/infrastructure/geocoder.token';
import { NODE_CONTACT_FIELDS } from '../fixtures/node-contact.fixture';

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

// Stands in for Google: answers with whatever the current test set up.
class FakeGeocoder implements Geocoder {
  next: GeocodeResult | null | 'unavailable' = null;
  calls = 0;

  geocode(): Promise<GeocodeResult | null> {
    this.calls += 1;
    if (this.next === 'unavailable') {
      return Promise.reject(new GeocoderUnavailableError('simulated outage'));
    }
    return Promise.resolve(this.next);
  }
}

// "Admiralty Way, Lekki" as a precise street-level match.
const LEKKI: GeocodeResult = {
  latitude: 6.4474,
  longitude: 3.4723,
  uncertaintyMeters: 150,
  formattedAddress: 'Admiralty Way, Lekki Phase 1, Lagos, Nigeria',
};

describe('Node location check (e2e)', () => {
  let app: INestApplication<App>;
  let nodes: Repository<NodeEntity>;
  let users: Repository<UserEntity>;
  let memberships: Repository<NodeMembershipEntity>;
  let adminCookie: string;
  let operatorCookie: string;
  let operatorId: string;
  const geocoder = new FakeGeocoder();
  const namePrefix = 'node-location.e2e.test';
  const operatorEmail = 'operator@node-location.e2e.test';

  function payload(name: string, overrides: Record<string, unknown> = {}) {
    return {
      name: `${namePrefix} ${name}`,
      address: '45 Admiralty Way',
      city: 'Lekki',
      state: 'Lagos',
      latitude: 6.448,
      longitude: 3.473,
      capacity: 20,
      ...NODE_CONTACT_FIELDS,
      ...overrides,
    };
  }

  function createAsAdmin(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/nodes')
      .set('Cookie', [adminCookie])
      .send(body);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GEOCODER)
      .useValue(geocoder)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    nodes = moduleFixture.get(getRepositoryToken(NodeEntity));
    users = moduleFixture.get(getRepositoryToken(UserEntity));
    memberships = moduleFixture.get(getRepositoryToken(NodeMembershipEntity));
    const jwtService = moduleFixture.get(JwtService);

    adminCookie = `access_token=${jwtService.sign({ sub: 'admin-id', role: UserRole.ADMIN })}`;

    const operator = await users.save(
      users.create({
        email: operatorEmail,
        passwordHash: 'not-used',
        firstName: 'Operator',
        lastName: 'Tester',
        phone: '+2348012345678',
        role: UserRole.NODE_OPERATOR,
        status: UserStatus.ACTIVE,
        consentAcceptedAt: new Date(),
      }),
    );
    operatorId = operator.id;
    operatorCookie = `access_token=${jwtService.sign({ sub: operator.id, role: UserRole.NODE_OPERATOR })}`;
  });

  beforeEach(() => {
    geocoder.next = LEKKI;
    geocoder.calls = 0;
  });

  afterAll(async () => {
    await memberships.delete({ userId: operatorId });
    await nodes
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: `${namePrefix}%` })
      .execute();
    await users.delete({ email: operatorEmail });
    await app.close();
  });

  it('marks a Node verified when the pin agrees with the address', async () => {
    const response = await createAsAdmin(payload('match')).expect(201);

    expect((response.body as SuccessBody).data.locationCheck).toBe('verified');
  });

  it('rejects a pin far from where the address geocodes, saying where it should be', async () => {
    // Pinned in Port Harcourt while the address is in Lekki.
    const response = await createAsAdmin(
      payload('mismatch', { latitude: 4.7781, longitude: 6.9847 }),
    ).expect(400);

    const error = (response.body as ErrorBody).error;
    expect(error.code).toBe('NODE_LOCATION_MISMATCH');
    expect(error.message).toContain('Admiralty Way, Lekki Phase 1');
    expect(await nodes.countBy({ name: `${namePrefix} mismatch` })).toBe(0);
  });

  it('accepts the Node as unverified when the geocoder is down', async () => {
    geocoder.next = 'unavailable';

    const response = await createAsAdmin(
      payload('outage', { latitude: 4.7781, longitude: 6.9847 }),
    ).expect(201);

    expect((response.body as SuccessBody).data.locationCheck).toBe(
      'unverified',
    );
  });

  it('accepts the Node as unverified when the address is unknown to the geocoder', async () => {
    geocoder.next = null;

    const response = await createAsAdmin(payload('unknown')).expect(201);

    expect((response.body as SuccessBody).data.locationCheck).toBe(
      'unverified',
    );
  });

  it('lets an Admin force a pin the geocoder disagrees with, without a lookup', async () => {
    const response = await createAsAdmin(
      payload('forced', {
        latitude: 4.7781,
        longitude: 6.9847,
        forceLocation: true,
      }),
    ).expect(201);

    expect((response.body as SuccessBody).data.locationCheck).toBe(
      'admin_override',
    );
    expect(geocoder.calls).toBe(0);
  });

  it('re-checks when an Admin moves the pin, and leaves other updates alone', async () => {
    const created = await createAsAdmin(payload('patch')).expect(201);
    const id = (created.body as SuccessBody).data.id as string;
    geocoder.calls = 0;

    await request(app.getHttpServer())
      .patch(`/api/v1/nodes/${id}`)
      .set('Cookie', [adminCookie])
      .send({ capacity: 25 })
      .expect(200);
    expect(geocoder.calls).toBe(0);

    const moved = await request(app.getHttpServer())
      .patch(`/api/v1/nodes/${id}`)
      .set('Cookie', [adminCookie])
      .send({ latitude: 4.7781, longitude: 6.9847 })
      .expect(400);
    expect((moved.body as ErrorBody).error.code).toBe('NODE_LOCATION_MISMATCH');
    const unchanged = await nodes.findOneByOrFail({ id });
    expect(unchanged.latitude).toBeCloseTo(6.448);
  });

  it('rejects operator onboarding with a mismatched pin before creating anything', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/node-operators/onboarding')
      .set('Cookie', [operatorCookie])
      .send(
        payload('onboard-mismatch', { latitude: 4.7781, longitude: 6.9847 }),
      )
      .expect(400);

    expect((response.body as ErrorBody).error.code).toBe(
      'NODE_LOCATION_MISMATCH',
    );
    expect(await memberships.countBy({ userId: operatorId })).toBe(0);
  });

  it('does not let an operator use the Admin override', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/node-operators/onboarding')
      .set('Cookie', [operatorCookie])
      .send(payload('onboard-force', { forceLocation: true }))
      .expect(400);
  });
});
