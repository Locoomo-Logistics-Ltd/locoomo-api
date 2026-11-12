import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { AdminPermission } from '../../../common/auth/admin-permission.enum';

export interface ApprovalExecutionContext {
  approvalId: string;
  requestedByUserId: string;
  approvedByUserId: string;
}

// A module that owns a sensitive action (merchants' wallet adjustments,
// claim payouts, …) registers one of these on init. The approvals service
// stays generic and never imports that module.
export interface ApprovalActionHandler {
  // Permission both the maker and the checker must hold.
  readonly permission: AdminPermission;
  // Validate (and normalise) the payload when the request is created, so a
  // malformed request fails then, not at approval time. Returns the
  // payload to store plus the queue summary line.
  prepare(
    payload: Record<string, unknown>,
    manager: EntityManager,
  ): Promise<{
    payload: Record<string, unknown>;
    summary: string;
    merchantId?: string | null;
  }>;
  // Runs inside the approval transaction — throwing rolls the approval back
  // and the request stays pending.
  execute(
    payload: Record<string, unknown>,
    context: ApprovalExecutionContext,
    manager: EntityManager,
  ): Promise<Record<string, unknown> | void>;
}

@Injectable()
export class ApprovalActionRegistry {
  private readonly handlers = new Map<string, ApprovalActionHandler>();

  register(action: string, handler: ApprovalActionHandler): void {
    if (this.handlers.has(action)) {
      throw new Error(`Approval action already registered: ${action}`);
    }
    this.handlers.set(action, handler);
  }

  get(action: string): ApprovalActionHandler | undefined {
    return this.handlers.get(action);
  }
}
