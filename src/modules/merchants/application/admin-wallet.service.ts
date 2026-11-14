import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { AuditService } from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import type { CursorPage } from '../../../common/pagination/cursor';
import {
  ApprovalActionRegistry,
  ApprovalExecutionContext,
} from '../../admin/application/approval-action.registry';
import { ApprovalService } from '../../admin/application/approval.service';
import type { ApiKeyMode } from '../domain/api-key';
import {
  formatNaira,
  HoldStatus,
  parseAdjustmentPayload,
  WALLET_ADJUSTMENT_ACTION,
} from '../domain/wallet';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import type {
  ListWalletEntriesQueryDto,
  RequestWalletAdjustmentDto,
} from '../interface/dto/wallet.dto';
import type { AdminActor } from './admin-merchants.service';
import { TopUpView, WalletTopUpService } from './wallet-top-up.service';
import {
  WalletEntryView,
  WalletHoldView,
  WalletService,
  WalletView,
} from './wallet.service';

const DEFAULT_MERCHANT_NOTE = 'Adjustment by Locoomo';

export interface WalletAdjustmentRequested {
  approvalId: string;
  status: string;
  summary: string;
  expiresAt: string;
}

// Admin app: a merchant's wallet, and manual adjustments under the
// two-admin rule (plan §8.6, E12). The adjustment runs only when a second
// `finance` admin approves it in the approvals queue.
@Injectable()
export class AdminWalletService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
    private readonly approvals: ApprovalService,
    private readonly registry: ApprovalActionRegistry,
    private readonly audit: AuditService,
    private readonly topUpService: WalletTopUpService,
  ) {}

  onModuleInit(): void {
    this.registry.register(WALLET_ADJUSTMENT_ACTION, {
      permission: AdminPermission.FINANCE,
      prepare: (payload, manager) => this.prepare(payload, manager),
      execute: (payload, context, manager) =>
        this.execute(payload, context, manager),
    });
  }

  async summary(merchantId: string, mode: ApiKeyMode): Promise<WalletView> {
    await this.merchantOf(this.dataSource.manager, merchantId);
    return this.wallet.summary(merchantId, mode);
  }

  async entries(
    merchantId: string,
    mode: ApiKeyMode,
    query: ListWalletEntriesQueryDto,
  ): Promise<CursorPage<WalletEntryView>> {
    await this.merchantOf(this.dataSource.manager, merchantId);
    return this.wallet.entries(merchantId, mode, query);
  }

  async holds(
    merchantId: string,
    mode: ApiKeyMode,
    status: HoldStatus | undefined,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<WalletHoldView>> {
    await this.merchantOf(this.dataSource.manager, merchantId);
    return this.wallet.holds(merchantId, mode, status, limit, cursor);
  }

  async topUps(
    merchantId: string,
    mode: ApiKeyMode,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<TopUpView>> {
    await this.merchantOf(this.dataSource.manager, merchantId);
    return this.topUpService.list(merchantId, mode, limit, cursor);
  }

  async requestAdjustment(
    actor: AdminActor,
    merchantId: string,
    dto: RequestWalletAdjustmentDto,
  ): Promise<WalletAdjustmentRequested> {
    const request = await this.approvals.request({
      action: WALLET_ADJUSTMENT_ACTION,
      payload: {
        merchantId,
        mode: dto.mode,
        amountKobo: dto.amountKobo,
        merchantNote: dto.merchantNote?.trim() || DEFAULT_MERCHANT_NOTE,
      },
      reason: dto.reason,
      requestedByUserId: actor.userId,
      context: actor.context,
    });
    return {
      approvalId: request.id,
      status: request.status,
      summary: request.summary,
      expiresAt: request.expiresAt.toISOString(),
    };
  }

  // Runs when the request is raised: a bad request fails now, not at approval.
  private async prepare(
    payload: Record<string, unknown>,
    manager: EntityManager,
  ): Promise<{
    payload: Record<string, unknown>;
    summary: string;
    merchantId: string;
  }> {
    const parsed = parseAdjustmentPayload(payload);
    if (!parsed) {
      // The DTO already validated it; reaching this is a bug.
      throw new Error('Malformed wallet adjustment payload');
    }
    const merchant = await this.merchantOf(manager, parsed.merchantId);
    const note =
      typeof payload.merchantNote === 'string' && payload.merchantNote
        ? payload.merchantNote.slice(0, 200)
        : DEFAULT_MERCHANT_NOTE;
    const credit = parsed.amountKobo > 0;
    return {
      payload: { ...parsed, merchantNote: note },
      summary: `${credit ? 'Credit' : 'Debit'} ${formatNaira(
        Math.abs(parsed.amountKobo),
      )} ${credit ? 'to' : 'from'} ${merchant.tradingName} (${parsed.mode} wallet)`,
      merchantId: merchant.id,
    };
  }

  // Inside the approval's transaction: throwing leaves it pending.
  private async execute(
    payload: Record<string, unknown>,
    context: ApprovalExecutionContext,
    manager: EntityManager,
  ): Promise<Record<string, unknown>> {
    const parsed = parseAdjustmentPayload(payload);
    if (!parsed) {
      throw new Error(`Malformed wallet adjustment ${context.approvalId}`);
    }
    const entry = await this.wallet.adjust(manager, {
      merchantId: parsed.merchantId,
      mode: parsed.mode,
      amountKobo: parsed.amountKobo,
      description:
        typeof payload.merchantNote === 'string'
          ? payload.merchantNote
          : DEFAULT_MERCHANT_NOTE,
      approvalId: context.approvalId,
      createdByUserId: context.requestedByUserId,
    });
    await this.audit.record(
      {
        actor: { type: 'user', id: context.approvedByUserId, role: 'admin' },
        action: 'wallet.adjusted',
        merchantId: parsed.merchantId,
        target: { type: 'wallet_entry', id: entry.id },
        metadata: {
          approvalId: context.approvalId,
          requestedByUserId: context.requestedByUserId,
          mode: parsed.mode,
          amountKobo: parsed.amountKobo,
          balanceAfterKobo: entry.balanceAfterKobo,
        },
      },
      manager,
    );
    return {
      entryId: entry.id,
      amountKobo: entry.amountKobo,
      balanceAfterKobo: entry.balanceAfterKobo,
    };
  }

  private async merchantOf(
    manager: EntityManager,
    merchantId: string,
  ): Promise<MerchantEntity> {
    const merchant = await manager.findOneBy(MerchantEntity, {
      id: merchantId,
    });
    if (!merchant) {
      throw new EntityNotFoundException('Merchant', merchantId);
    }
    return merchant;
  }
}
