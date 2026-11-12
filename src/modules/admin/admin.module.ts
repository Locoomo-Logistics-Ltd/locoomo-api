import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { ApprovalActionRegistry } from './application/approval-action.registry';
import { ApprovalService } from './application/approval.service';
import { CapacityAuditQueryService } from './application/capacity-audit-query.service';
import { ApprovalRequestEntity } from './infrastructure/entities/approval-request.entity';
import { AdminApprovalsController } from './interface/admin-approvals.controller';
import { AdminCapacityAuditController } from './interface/admin-capacity-audit.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalRequestEntity]),
    // AdminPermissionService: approver/requester permission checks.
    IdentityModule,
  ],
  controllers: [AdminCapacityAuditController, AdminApprovalsController],
  providers: [
    CapacityAuditQueryService,
    ApprovalActionRegistry,
    ApprovalService,
  ],
  // Modules that own a sensitive action register its handler with the
  // registry and raise requests through ApprovalService (maker-checker).
  exports: [ApprovalActionRegistry, ApprovalService],
})
export class AdminModule {}
