import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/bootstrap';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('/api/v1/ (GET)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/')
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      data: 'Hello World!',
      meta: {
        correlationId: expect.any(String) as string,
        timestamp: expect.any(String) as string,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });
});
