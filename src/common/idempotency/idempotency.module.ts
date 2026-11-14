import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyCleanupService } from './idempotency-cleanup.service';
import { IdempotencyKeyEntity } from './idempotency-key.entity';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

@Module({
  imports: [TypeOrmModule.forFeature([IdempotencyKeyEntity])],
  providers: [
    IdempotencyService,
    IdempotencyInterceptor,
    IdempotencyCleanupService,
  ],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
