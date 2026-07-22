import {
  Body,
  Controller,
  Get,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IsEmail, IsString, MinLength } from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types';
import { CommonModule } from '../src/common/common.module';
import { ConfigModule } from '../src/config/config.module';
import { EntityNotFoundException } from '../src/common/exceptions';
import { configureApp } from '../src/bootstrap';

class CreateTestDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;
}

@Controller('test')
class TestController {
  @Post()
  create(@Body() dto: CreateTestDto): CreateTestDto {
    return dto;
  }

  @Get('not-found')
  triggerNotFound(): never {
    throw new EntityNotFoundException('Widget', 'xyz');
  }

  @Get('boom')
  triggerUnknownError(): never {
    throw new Error('unexpected failure');
  }
}

// Only registered inside this test's TestingModule — never part of the real
// app. Exercises the full pipeline (CommonModule + ValidationPipe) the same
// way main.ts wires it, without needing a real business route to exist yet.
@Module({
  imports: [ConfigModule, CommonModule],
  controllers: [TestController],
})
class TestAppModule {}

interface SuccessBody {
  success: true;
  data: unknown;
  meta: { correlationId: string; timestamp: string };
}

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: unknown;
  };
}

describe('Global request pipeline (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('wraps a successful response in the success envelope with a correlation id', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test')
      .send({ email: 'sender@locoomo.test', name: 'Ada' })
      .expect(201);

    const body = response.body as SuccessBody;
    expect(body).toEqual({
      success: true,
      data: { email: 'sender@locoomo.test', name: 'Ada' },
      meta: {
        correlationId: expect.any(String) as string,
        timestamp: expect.any(String) as string,
      },
    });
    expect(response.headers['x-correlation-id']).toBeDefined();
  });

  it('reuses an incoming X-Correlation-Id header', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test')
      .set('X-Correlation-Id', 'client-abc-123')
      .send({ email: 'a@b.com', name: 'Bo' })
      .expect(201);

    const body = response.body as SuccessBody;
    expect(response.headers['x-correlation-id']).toBe('client-abc-123');
    expect(body.meta.correlationId).toBe('client-abc-123');
  });

  it('returns structured field errors for an invalid payload', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test')
      .send({ email: 'not-an-email', name: 'A' })
      .expect(400);

    const body = response.body as ErrorBody;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    const details = body.error.details as Array<{ field: string }>;
    expect(details.map((d) => d.field).sort()).toEqual(['email', 'name']);
  });

  it('rejects unexpected fields (forbidNonWhitelisted)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/test')
      .send({ email: 'a@b.com', name: 'Bo', extraField: 'nope' })
      .expect(400);
  });

  it('maps a thrown BusinessException to its declared status and code', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test/not-found')
      .expect(404);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Widget with id xyz was not found',
        correlationId: expect.any(String) as string,
      },
    });
  });

  it('maps a completely unexpected error to a generic 500', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test/boom')
      .expect(500);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        correlationId: expect.any(String) as string,
      },
    });
  });

  it('returns a real error envelope for an unmatched route', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .expect(404);

    const body = response.body as ErrorBody;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
