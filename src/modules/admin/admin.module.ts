import { Module } from '@nestjs/common';
import { CapacityAuditQueryService } from './application/capacity-audit-query.service';
import { AdminCapacityAuditController } from './interface/admin-capacity-audit.controller';

@Module({
  controllers: [AdminCapacityAuditController],
  providers: [CapacityAuditQueryService],
})
export class AdminModule {}
