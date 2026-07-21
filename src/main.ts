import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { createAppValidationPipe } from './common/pipes';
import { Env } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Env, true>);

  app.useGlobalPipes(createAppValidationPipe());

  await app.listen(config.get('PORT', { infer: true }));
}
bootstrap().catch((error: unknown) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
