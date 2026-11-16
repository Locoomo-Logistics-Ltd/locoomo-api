import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { ApprovalActionRegistry } from './application/approval-action.registry';
import { ApprovalService } from './application/approval.service';
import { CapacityAuditQueryService } from './application/capacity-audit-query.service';
import { ApprovalRequestEntity } from './infrastructure/entities/approval-request.entity';
import { AdminApprovalsController } from './interface/admin-approvals.controller';
import { AdminCapacityAuditController } from './interface/admin-capacity-audit.controller';
import { AdminOrdersQueryService } from './application/admin-orders-query.service';
import { PlatformHealthService } from './application/platform-health.service';
import { AdminOpsController } from './interface/admin-ops.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalRequestEntity]),
    // AdminPermissionService: approver/requester permission checks.
    IdentityModule,
    // OutboxService: platform health alert emails.
    NotificationsModule,
  ],
  controllers: [
    AdminCapacityAuditController,
    AdminApprovalsController,
    AdminOpsController,
  ],
  providers: [
    CapacityAuditQueryService,
    AdminOrdersQueryService,
    PlatformHealthService,
    ApprovalActionRegistry,
    ApprovalService,
  ],
  // Modules that own a sensitive action register its handler with the
  // registry and raise requests through ApprovalService (maker-checker).
  exports: [ApprovalActionRegistry, ApprovalService],
})
export class AdminModule {}
