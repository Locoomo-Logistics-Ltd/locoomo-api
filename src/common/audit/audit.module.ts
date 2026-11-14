import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEventEntity } from './audit-event.entity';
import { AuditService } from './audit.service';

// Global: auditing is a cross-cutting concern every module needs, and
// importing AuditModule into each one adds nothing but noise.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditEventEntity])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
