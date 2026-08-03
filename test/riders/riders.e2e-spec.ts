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
import { hashPassword } from '../../src/modules/identity/domain/password-hasher';
import { UserEntity } from '../../src/modules/identity/infrastructure/entities/user.entity';
import { CloudinaryService } from '../../src/modules/riders/infrastructure/cloudinary.service';
import { RiderProfileEntity } from '../../src/modules/riders/infrastructure/entities/rider-profile.entity';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; correlationId: string };
}

interface SuccessBody {
  success: true;
  data: Record<string, unknown>;
}

// Fakes the Cloudinary boundary the same way FakeNotificationSender fakes
// SMTP — CloudinaryService itself is separately verified against the real
// account (see the module build), so the e2e suite doesn't need real
// network/credentials to have confidence in this flow.
class FakeCloudinaryService {
  uploadedPublicIds = new Set<string>();

  generateUploadSignature(folder: string) {
    return {
      signature: 'fake-signature',
      timestamp: Math.floor(Date.now() / 1000),
      apiKey: 'fake-api-key',
      cloudName: 'fake-cloud',
      folder,
    };
  }

  resourceExists(publicId: string): Promise<boolean> {
    return Promise.resolve(this.uploadedPublicIds.has(publicId));
  }

  getSignedViewUrl(publicId: string): string {
    return `https://fake.cloudinary.test/${publicId}`;
  }
}

describe('Riders (e2e)', () => {
  let app: INestApplication<App>;
  let users: Repository<UserEntity>;
  let profiles: Repository<RiderProfileEntity>;
  let jwtService: JwtService;
  let fakeCloudinary: FakeCloudinaryService;
  let adminCookie: string;

  const emailPattern = '%@riders.e2e.test';
  const password = 'Correct-Horse-Battery-1';

  function asAdmin(req: request.Test): request.Test {
    return req.set('Cookie', [adminCookie]);
  }

  async function registerRider(email: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Rider',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.RIDER,
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

  function fakeUploadedPublicId(tag: string): string {
    const publicId = `riders/e2e-test/${tag}-${Math.random().toString(36).slice(2)}`;
    fakeCloudinary.uploadedPublicIds.add(publicId);
    return publicId;
  }

  async function onboardRider(
    operatorCookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/riders/onboarding')
      .set('Cookie', [operatorCookie])
      .send({
        currentEmployer: 'Existing Delivery Co',
        documentType: 'rating_screenshot',
        cloudinaryPublicId: fakeUploadedPublicId('rating'),
        ...overrides,
      });
  }

  beforeAll(async () => {
    fakeCloudinary = new FakeCloudinaryService();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CloudinaryService)
      .useValue(fakeCloudinary)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    users = moduleFixture.get(getRepositoryToken(UserEntity));
    profiles = moduleFixture.get(getRepositoryToken(RiderProfileEntity));
    jwtService = moduleFixture.get(JwtService);

    const admin = await users.save(
      users.create({
        email: 'admin@riders.e2e.test',
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
    await app.close();
  });

  it('self-registers a Rider into pending_review status, able to log in immediately', async () => {
    const email = 'register-happy-path@riders.e2e.test';
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        firstName: 'Rider',
        lastName: 'Tester',
        email,
        phone: '+2348012345678',
        password,
        passwordConfirmation: password,
        consentAccepted: true,
        role: UserRole.RIDER,
      })
      .expect(201);

    const data = (response.body as SuccessBody).data;
    expect(data.role).toBe('rider');
    expect(data.status).toBe('pending_review');

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
  });

  describe('upload signature', () => {
    const email = 'signature-flow@riders.e2e.test';
    let riderCookie: string;

    beforeAll(async () => {
      await registerRider(email);
      riderCookie = await loginCookie(email);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .get(
          '/api/v1/riders/verification/upload-signature?documentType=rating_screenshot',
        )
        .expect(401);
    });

    it('rejects a non-Rider role', async () => {
      const consumerToken = jwtService.sign({
        sub: 'some-consumer-id',
        role: UserRole.CONSUMER,
      });
      await request(app.getHttpServer())
        .get(
          '/api/v1/riders/verification/upload-signature?documentType=rating_screenshot',
        )
        .set('Cookie', [`access_token=${consumerToken}`])
        .expect(403);
    });

    it('rejects an unknown documentType', async () => {
      await request(app.getHttpServer())
        .get(
          '/api/v1/riders/verification/upload-signature?documentType=drivers_license',
        )
        .set('Cookie', [riderCookie])
        .expect(400);
    });

    it('returns a signature scoped to the caller and document type', async () => {
      const response = await request(app.getHttpServer())
        .get(
          '/api/v1/riders/verification/upload-signature?documentType=rating_screenshot',
        )
        .set('Cookie', [riderCookie])
        .expect(200);

      const data = (response.body as SuccessBody).data as {
        signature: string;
        folder: string;
      };
      expect(data.signature).toBeTruthy();
      expect(data.folder).toContain('rating_screenshot');
    });
  });

  describe('onboarding', () => {
    const email = 'onboard-happy-path@riders.e2e.test';
    let riderCookie: string;

    beforeAll(async () => {
      await registerRider(email);
      riderCookie = await loginCookie(email);
    });

    it('rejects an unauthenticated onboarding attempt', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/riders/onboarding')
        .send({
          currentEmployer: 'Nope',
          documentType: 'rating_screenshot',
          cloudinaryPublicId: 'irrelevant',
        })
        .expect(401);
      expect((response.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects onboarding from a non-Rider role', async () => {
      const consumerToken = jwtService.sign({
        sub: 'some-consumer-id',
        role: UserRole.CONSUMER,
      });
      const response = await request(app.getHttpServer())
        .post('/api/v1/riders/onboarding')
        .set('Cookie', [`access_token=${consumerToken}`])
        .send({
          currentEmployer: 'Nope',
          documentType: 'rating_screenshot',
          cloudinaryPublicId: 'irrelevant',
        })
        .expect(403);
      expect((response.body as ErrorBody).error.code).toBe('FORBIDDEN');
    });

    it('rejects an unconfirmed (never actually uploaded) document', async () => {
      const response = await onboardRider(riderCookie, {
        cloudinaryPublicId: 'riders/e2e-test/never-uploaded-anything',
      });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error.code).toBe(
        'INVALID_VERIFICATION_DOCUMENT',
      );
    });

    it('rejects a missing currentEmployer', async () => {
      const publicId = fakeUploadedPublicId('missing-employer');
      await request(app.getHttpServer())
        .post('/api/v1/riders/onboarding')
        .set('Cookie', [riderCookie])
        .send({
          documentType: 'rating_screenshot',
          cloudinaryPublicId: publicId,
        })
        .expect(400);
    });

    it('creates a pending RiderProfile with the confirmed document', async () => {
      const response = await onboardRider(riderCookie);
      expect(response.status).toBe(201);

      const data = (response.body as SuccessBody).data as {
        profileId: string;
        status: string;
        documents: { documentType: string; viewUrl: string }[];
      };
      expect(data.status).toBe('pending');
      expect(data.documents).toHaveLength(1);
      expect(data.documents[0].documentType).toBe('rating_screenshot');
      expect(data.documents[0].viewUrl).toContain('fake.cloudinary.test');

      const user = await users.findOneByOrFail({ email });
      const profile = await profiles.findOneByOrFail({ userId: user.id });
      expect(profile.id).toBe(data.profileId);
    });

    it('returns the same profile via GET /riders/me', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/riders/me')
        .set('Cookie', [riderCookie])
        .expect(200);
      const data = (response.body as SuccessBody).data as { status: string };
      expect(data.status).toBe('pending');
    });

    it('rejects a second onboarding attempt from the same rider', async () => {
      const response = await onboardRider(riderCookie);
      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).error.code).toBe(
        'RIDER_ALREADY_ONBOARDED',
      );
    });
  });

  describe('admin review queue and approval', () => {
    const email = 'approval-flow@riders.e2e.test';
    let riderCookie: string;
    let profileId: string;

    beforeAll(async () => {
      await registerRider(email);
      riderCookie = await loginCookie(email);

      const response = await onboardRider(riderCookie, {
        currentEmployer: 'Speedy Dispatch Ltd',
      });
      const data = (response.body as SuccessBody).data as { profileId: string };
      profileId = data.profileId;
    });

    it('rejects a non-admin listing the pending queue', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/riders/pending')
        .set('Cookie', [riderCookie])
        .expect(403);
    });

    it('lists the rider in the Admin pending queue with a signed document URL', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).get('/api/v1/riders/pending?limit=100'),
      ).expect(200);

      const data = (response.body as SuccessBody).data as {
        items: {
          profileId: string;
          userEmail: string;
          currentEmployer: string;
          documents: { viewUrl: string }[];
        }[];
      };
      const entry = data.items.find((i) => i.profileId === profileId);
      expect(entry).toBeDefined();
      expect(entry?.userEmail).toBe(email);
      expect(entry?.currentEmployer).toBe('Speedy Dispatch Ltd');
      expect(entry?.documents[0].viewUrl).toContain('fake.cloudinary.test');
    });

    it('rejects a non-admin approval', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/riders/${profileId}/approve`)
        .set('Cookie', [riderCookie])
        .expect(403);
    });

    it('returns 404 approving a non-existent profile', async () => {
      await asAdmin(
        request(app.getHttpServer()).patch(
          '/api/v1/riders/00000000-0000-0000-0000-000000000000/approve',
        ),
      ).expect(404);
    });

    it('approves the rider, activating both the User and the RiderProfile', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).patch(
          `/api/v1/riders/${profileId}/approve`,
        ),
      ).expect(200);

      const data = (response.body as SuccessBody).data as { status: string };
      expect(data.status).toBe('active');

      const user = await users.findOneByOrFail({ email });
      expect(user.status).toBe(UserStatus.ACTIVE);

      const profile = await profiles.findOneByOrFail({ id: profileId });
      expect(profile.status).toBe('active');
    });

    it('no longer appears in the pending queue after approval', async () => {
      const response = await asAdmin(
        request(app.getHttpServer()).get('/api/v1/riders/pending?limit=100'),
      ).expect(200);
      const data = (response.body as SuccessBody).data as {
        items: { profileId: string }[];
      };
      expect(data.items.some((i) => i.profileId === profileId)).toBe(false);
    });
  });
});
