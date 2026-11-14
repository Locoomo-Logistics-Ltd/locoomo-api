import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { PaginatedResultDto } from '../../../common/dto/paginated-result.dto';
import {
  EntityNotFoundException,
  InsufficientRoleException,
} from '../../../common/exceptions';
import { AdminPermissionService } from '../../identity/application/admin-permission.service';
import {
  ApprovalNotPendingException,
  SelfApprovalNotAllowedException,
  UnknownApprovalActionException,
} from '../domain/approval-exceptions';
import { ApprovalStatus } from '../domain/approval-status.enum';
import { ApprovalRequestEntity } from '../infrastructure/entities/approval-request.entity';
import {
  ApprovalActionHandler,
  ApprovalActionRegistry,
} from './approval-action.registry';

// A pending request older than this can't be approved — circumstances (a
// wallet balance, a claim's evidence) may have changed since it was raised.
export const APPROVAL_TTL_DAYS = 7;

export interface RequestApprovalInput {
  action: string;
  payload: Record<string, unknown>;
  reason: string;
  requestedByUserId: string;
  context: AuditRequestContext;
}

@Injectable()
export class ApprovalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: ApprovalActionRegistry,
    private readonly permissions: AdminPermissionService,
    private readonly audit: AuditService,
  ) {}

  // Called by the owning module's own admin endpoint (which validated its
  // DTO) — there's deliberately no generic "create any approval" endpoint.
  async request(
    input: RequestApprovalInput,
    manager?: EntityManager,
  ): Promise<ApprovalRequestEntity> {
    const handler = this.handlerFor(input.action);
    await this.assertPermission(input.requestedByUserId, handler);

    const run = async (m: EntityManager): Promise<ApprovalRequestEntity> => {
      const prepared = await handler.prepare(input.payload, m);
      const repo = m.getRepository(ApprovalRequestEntity);
      const saved = await repo.save(
        repo.create({
          action: input.action,
          status: ApprovalStatus.PENDING,
          payload: prepared.payload,
          summary: prepared.summary.slice(0, 300),
          reason: input.reason,
          merchantId: prepared.merchantId ?? null,
          requestedByUserId: input.requestedByUserId,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_DAYS * 86_400_000),
        }),
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: input.requestedByUserId, role: 'admin' },
          action: 'approval.requested',
          merchantId: saved.merchantId,
          target: { type: 'approval_request', id: saved.id },
          metadata: { approvalAction: input.action, reason: input.reason },
          context: input.context,
        },
        m,
      );
      return saved;
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  async approve(
    approvalId: string,
    checkerUserId: string,
    note: string | null,
    context: AuditRequestContext,
  ): Promise<ApprovalRequestEntity> {
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, approvalId);
      if (request.requestedByUserId === checkerUserId) {
        throw new SelfApprovalNotAllowedException();
      }
      const handler = this.handlerFor(request.action);
      await this.assertPermission(checkerUserId, handler);

      const result = await handler.execute(
        request.payload,
        {
          approvalId: request.id,
          requestedByUserId: request.requestedByUserId,
          approvedByUserId: checkerUserId,
        },
        manager,
      );

      request.status = ApprovalStatus.EXECUTED;
      request.decidedByUserId = checkerUserId;
      request.decisionNote = note;
      request.decidedAt = new Date();
      request.result = result ?? null;
      const saved = await manager.save(request);

      await this.audit.record(
        {
          actor: { type: 'user', id: checkerUserId, role: 'admin' },
          action: 'approval.approved',
          merchantId: saved.merchantId,
          target: { type: 'approval_request', id: saved.id },
          metadata: {
            approvalAction: saved.action,
            requestedByUserId: saved.requestedByUserId,
            note,
          },
          context,
        },
        manager,
      );
      return saved;
    });
  }

  async reject(
    approvalId: string,
    checkerUserId: string,
    note: string,
    context: AuditRequestContext,
  ): Promise<ApprovalRequestEntity> {
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, approvalId);
      const handler = this.handlerFor(request.action);
      await this.assertPermission(checkerUserId, handler);
      return this.close(
        manager,
        request,
        ApprovalStatus.REJECTED,
        checkerUserId,
        note,
        'approval.rejected',
        context,
      );
    });
  }

  // The maker withdrawing their own request.
  async cancel(
    approvalId: string,
    userId: string,
    context: AuditRequestContext,
  ): Promise<ApprovalRequestEntity> {
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, approvalId);
      if (request.requestedByUserId !== userId) {
        throw new InsufficientRoleException();
      }
      return this.close(
        manager,
        request,
        ApprovalStatus.CANCELLED,
        userId,
        null,
        'approval.cancelled',
        context,
      );
    });
  }

  async list(
    status: ApprovalStatus | undefined,
    page: number,
    limit: number,
  ): Promise<PaginatedResultDto<ApprovalRequestEntity>> {
    await this.expireStale();
    const [items, total] = await this.dataSource
      .getRepository(ApprovalRequestEntity)
      .findAndCount({
        where: status ? { status } : {},
        order: {
          createdAt: status === ApprovalStatus.PENDING ? 'ASC' : 'DESC',
        },
        skip: (page - 1) * limit,
        take: limit,
      });
    return new PaginatedResultDto(items, page, limit, total);
  }

  async get(approvalId: string): Promise<ApprovalRequestEntity> {
    await this.expireStale();
    const request = await this.dataSource
      .getRepository(ApprovalRequestEntity)
      .findOneBy({ id: approvalId });
    if (!request) {
      throw new EntityNotFoundException('ApprovalRequest', approvalId);
    }
    return request;
  }

  // Lazy expiry: cheap single UPDATE, run before reads — no scheduler
  // needed for a queue only admins look at.
  private async expireStale(): Promise<void> {
    await this.dataSource.query(
      `UPDATE approval_requests SET status = $1, "updatedAt" = now()
        WHERE status = $2 AND "expiresAt" <= now()`,
      [ApprovalStatus.EXPIRED, ApprovalStatus.PENDING],
    );
  }

  private async lockPending(
    manager: EntityManager,
    approvalId: string,
  ): Promise<ApprovalRequestEntity> {
    const request = await manager.getRepository(ApprovalRequestEntity).findOne({
      where: { id: approvalId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request) {
      throw new EntityNotFoundException('ApprovalRequest', approvalId);
    }
    if (
      request.status === ApprovalStatus.PENDING &&
      request.expiresAt.getTime() <= Date.now()
    ) {
      request.status = ApprovalStatus.EXPIRED;
      await manager.save(request);
    }
    if (request.status !== ApprovalStatus.PENDING) {
      throw new ApprovalNotPendingException(request.status);
    }
    return request;
  }

  private async close(
    manager: EntityManager,
    request: ApprovalRequestEntity,
    status: ApprovalStatus,
    userId: string,
    note: string | null,
    auditAction: string,
    context: AuditRequestContext,
  ): Promise<ApprovalRequestEntity> {
    request.status = status;
    request.decidedByUserId = userId;
    request.decisionNote = note;
    request.decidedAt = new Date();
    const saved = await manager.save(request);
    await this.audit.record(
      {
        actor: { type: 'user', id: userId, role: 'admin' },
        action: auditAction,
        merchantId: saved.merchantId,
        target: { type: 'approval_request', id: saved.id },
        metadata: { approvalAction: saved.action, note },
        context,
      },
      manager,
    );
    return saved;
  }

  private handlerFor(action: string): ApprovalActionHandler {
    const handler = this.registry.get(action);
    if (!handler) {
      throw new UnknownApprovalActionException(action);
    }
    return handler;
  }

  private async assertPermission(
    userId: string,
    handler: ApprovalActionHandler,
  ): Promise<void> {
    if (!(await this.permissions.hasAny(userId, [handler.permission]))) {
      throw new InsufficientRoleException();
    }
  }
}
