import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AdminPermission } from '../../../common/auth/admin-permission.enum';
import { AuditService } from '../../../common/audit/audit.service';
import { CloudinaryService } from '../../../common/cloudinary/cloudinary.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import {
  CursorPage,
  CursorPosition,
  cursorTime,
  decodeCursor,
  toCursorPage,
} from '../../../common/pagination/cursor';
import {
  ApprovalActionRegistry,
  ApprovalExecutionContext,
} from '../../admin/application/approval-action.registry';
import { ApprovalService } from '../../admin/application/approval.service';
import type { ApiKeyMode } from '../domain/api-key';
import {
  CLAIM_PAYOUT_ACTION,
  ClaimStatus,
  parseClaimPayoutPayload,
} from '../domain/claim';
import {
  ClaimAlreadyDecidedException,
  ClaimPayoutPendingException,
  ClaimPayoutTooHighException,
  LiveModeOnlyException,
} from '../domain/exceptions/merchant.exceptions';
import { formatNaira } from '../domain/wallet';
import { MerchantClaimEntity } from '../infrastructure/entities/merchant-claim.entity';
import type { AdminActor } from './admin-merchants.service';
import {
  ClaimView,
  claimView,
  MerchantClaimsService,
} from './merchant-claims.service';

const EVIDENCE_LINK_TTL_SECONDS = 15 * 60;
const ms = cursorTime('c."createdAt"');

export interface AdminClaimView extends ClaimView {
  merchantId: string;
  merchantName: string;
  mode: ApiKeyMode;
  shipmentStatus: string;
  internalNote: string | null;
  // A payout raised and waiting for a second finance admin.
  pendingPayoutApprovalId: string | null;
}

export interface AdminClaimDetail extends AdminClaimView {
  evidenceLinks: { publicId: string; url: string; expiresAt: string }[];
}

export interface ClaimPayoutRequested {
  approvalId: string;
  status: string;
  summary: string;
  expiresAt: string;
}

type AdminRow = Parameters<typeof claimView>[0] & {
  merchantName: string;
  shipmentStatus: string;
  pendingApprovalId: string | null;
};

// Admin app: the claims queue (plan §6.6, E12). Ops and finance
// investigate and may reject; only `finance` raises a payout, and it runs
// when a second `finance` admin approves it in /admin/approvals.
@Injectable()
export class AdminClaimsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly claims: MerchantClaimsService,
    private readonly approvals: ApprovalService,
    private readonly registry: ApprovalActionRegistry,
    private readonly cloudinary: CloudinaryService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register(CLAIM_PAYOUT_ACTION, {
      permission: AdminPermission.FINANCE,
      prepare: (payload, manager) => this.prepare(payload, manager),
      execute: (payload, context, manager) =>
        this.execute(payload, context, manager),
    });
  }

  async list(filter: {
    status?: ClaimStatus;
    merchantId?: string;
    mode: ApiKeyMode;
    limit: number;
    cursor?: string;
  }): Promise<CursorPage<AdminClaimView>> {
    const params: unknown[] = [filter.mode, filter.limit + 1];
    const where = ['c.mode = $1'];
    if (filter.status) {
      params.push(filter.status);
      where.push(`c.status = $${params.length}`);
    }
    if (filter.merchantId) {
      params.push(filter.merchantId);
      where.push(`c."merchantId" = $${params.length}`);
    }
    const after = decodeCursor(filter.cursor);
    if (after) {
      params.push(after.t, after.id);
      where.push(
        `(${ms}, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows = await this.rows(
      this.dataSource.manager,
      `${where.join(' AND ')} ORDER BY ${ms} DESC, c.id DESC LIMIT $2`,
      params,
    );
    return toCursorPage<AdminRow, AdminClaimView>(
      rows,
      filter.limit,
      (row): CursorPosition => ({ t: row.createdAt.toISOString(), id: row.id }),
      (row) => this.view(row),
    );
  }

  async get(id: string): Promise<AdminClaimDetail> {
    const row = await this.row(this.dataSource.manager, id);
    return {
      ...this.view(row),
      evidenceLinks: row.evidence.map((publicId) => {
        const link = this.cloudinary.getExpiringDownloadUrl(
          publicId,
          EVIDENCE_LINK_TTL_SECONDS,
        );
        return {
          publicId,
          url: link.url,
          expiresAt: link.expiresAt.toISOString(),
        };
      }),
    };
  }

  // Investigation notes, admins only.
  async note(
    actor: AdminActor,
    id: string,
    internalNote: string,
  ): Promise<AdminClaimDetail> {
    await this.dataSource.transaction(async (manager) => {
      const claim = await this.claims.lockClaim(manager, id);
      claim.internalNote = internalNote.trim().slice(0, 2000) || null;
      await manager.save(claim);
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId, role: 'admin' },
          action: 'merchant.claim_noted',
          merchantId: claim.merchantId,
          target: { type: 'merchant_claim', id },
          context: actor.context,
        },
        manager,
      );
    });
    return this.get(id);
  }

  async reject(
    actor: AdminActor,
    id: string,
    input: { merchantNote: string; internalNote?: string },
  ): Promise<AdminClaimDetail> {
    await this.dataSource.transaction(async (manager) => {
      const claim = await this.claims.lockClaim(manager, id);
      await this.assertLiveAndNoPendingPayout(manager, claim);
      if (input.internalNote?.trim()) {
        claim.internalNote = input.internalNote.trim().slice(0, 2000);
      }
      await this.claims.reject(manager, claim, {
        merchantNote: input.merchantNote.trim(),
        decidedByUserId: actor.userId,
      });
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId, role: 'admin' },
          action: 'merchant.claim_rejected',
          merchantId: claim.merchantId,
          target: { type: 'merchant_claim', id },
          context: actor.context,
        },
        manager,
      );
    });
    return this.get(id);
  }

  async requestPayout(
    actor: AdminActor,
    id: string,
    input: { amountKobo: number; merchantNote?: string; reason: string },
  ): Promise<ClaimPayoutRequested> {
    return this.dataSource.transaction(async (manager) => {
      const claim = await this.claims.lockClaim(manager, id);
      await this.assertLiveAndNoPendingPayout(manager, claim);
      const request = await this.approvals.request(
        {
          action: CLAIM_PAYOUT_ACTION,
          payload: {
            claimId: claim.id,
            amountKobo: input.amountKobo,
            merchantNote: input.merchantNote?.trim() || null,
          },
          reason: input.reason,
          requestedByUserId: actor.userId,
          context: actor.context,
        },
        manager,
      );
      claim.payoutApprovalId = request.id;
      await manager.save(claim);
      return {
        approvalId: request.id,
        status: request.status,
        summary: request.summary,
        expiresAt: request.expiresAt.toISOString(),
      };
    });
  }

  // Runs when the payout is raised: a bad request fails now, not at approval.
  private async prepare(
    payload: Record<string, unknown>,
    manager: EntityManager,
  ): Promise<{
    payload: Record<string, unknown>;
    summary: string;
    merchantId: string;
  }> {
    const parsed = parseClaimPayoutPayload(payload);
    if (!parsed) {
      throw new Error('Malformed claim payout payload');
    }
    const row = await this.row(manager, parsed.claimId);
    if (row.status !== 'open') {
      throw new ClaimAlreadyDecidedException(row.status);
    }
    if (parsed.amountKobo > row.maxPayoutKobo) {
      throw new ClaimPayoutTooHighException(row.maxPayoutKobo);
    }
    return {
      payload: {
        ...parsed,
        merchantNote: parsed.merchantNote?.slice(0, 1000) ?? null,
      },
      summary: `Pay ${formatNaira(parsed.amountKobo)} to ${row.merchantName} for a ${row.type.replace('_', ' ')} claim on ${row.trackingCode}`,
      merchantId: row.merchantId,
    };
  }

  // Inside the approval's transaction: throwing leaves it pending.
  private async execute(
    payload: Record<string, unknown>,
    context: ApprovalExecutionContext,
    manager: EntityManager,
  ): Promise<Record<string, unknown>> {
    const parsed = parseClaimPayoutPayload(payload);
    if (!parsed) {
      throw new Error(`Malformed claim payout ${context.approvalId}`);
    }
    const claim = await this.claims.lockClaim(manager, parsed.claimId);
    await this.claims.approve(manager, claim, {
      amountKobo: parsed.amountKobo,
      merchantNote: parsed.merchantNote,
      approvalId: context.approvalId,
      decidedByUserId: context.approvedByUserId,
    });
    await this.audit.record(
      {
        actor: { type: 'user', id: context.approvedByUserId, role: 'admin' },
        action: 'merchant.claim_paid',
        merchantId: claim.merchantId,
        target: { type: 'merchant_claim', id: claim.id },
        metadata: {
          approvalId: context.approvalId,
          requestedByUserId: context.requestedByUserId,
          amountKobo: parsed.amountKobo,
          walletEntryId: claim.walletEntryId,
        },
      },
      manager,
    );
    return { claimId: claim.id, walletEntryId: claim.walletEntryId };
  }

  private async assertLiveAndNoPendingPayout(
    manager: EntityManager,
    claim: MerchantClaimEntity,
  ): Promise<void> {
    if (claim.mode !== 'live') {
      throw new LiveModeOnlyException(
        'Test claims are decided by the merchant in the sandbox',
      );
    }
    if (claim.status !== 'open') {
      throw new ClaimAlreadyDecidedException(claim.status);
    }
    const pending = await this.pendingApproval(manager, claim.payoutApprovalId);
    if (pending) {
      throw new ClaimPayoutPendingException(pending);
    }
  }

  private async pendingApproval(
    manager: EntityManager,
    approvalId: string | null,
  ): Promise<string | null> {
    if (!approvalId) {
      return null;
    }
    const [row] = await manager.query<{ id: string }[]>(
      `SELECT id FROM approval_requests
        WHERE id = $1 AND status = 'pending' AND "expiresAt" > now()`,
      [approvalId],
    );
    return row?.id ?? null;
  }

  private async row(manager: EntityManager, id: string): Promise<AdminRow> {
    const [row] = await this.rows(manager, 'c.id = $1', [id]);
    if (!row) {
      throw new EntityNotFoundException('Claim', id);
    }
    return row;
  }

  private async rows(
    manager: EntityManager,
    whereAndTail: string,
    params: unknown[],
  ): Promise<AdminRow[]> {
    const raw = await manager.query<
      (Record<string, unknown> & {
        declaredValueKobo: string | null;
        maxPayoutKobo: string;
        payoutKobo: string | null;
      })[]
    >(
      `SELECT c.*, s.reference, s."trackingCode", s.status AS "shipmentStatus",
              m."tradingName" AS "merchantName",
              (SELECT a.id FROM approval_requests a
                WHERE a.id = c."payoutApprovalId" AND a.status = 'pending'
                  AND a."expiresAt" > now()) AS "pendingApprovalId"
         FROM merchant_claims c
         JOIN merchant_shipments s ON s.id = c."shipmentId"
         JOIN merchants m ON m.id = c."merchantId"
        WHERE ${whereAndTail}`,
      params,
    );
    return raw.map((row) => ({
      ...row,
      declaredValueKobo:
        row.declaredValueKobo === null ? null : Number(row.declaredValueKobo),
      maxPayoutKobo: Number(row.maxPayoutKobo),
      payoutKobo: row.payoutKobo === null ? null : Number(row.payoutKobo),
    })) as unknown as AdminRow[];
  }

  private view(row: AdminRow): AdminClaimView {
    return {
      ...claimView(row),
      merchantId: row.merchantId,
      merchantName: row.merchantName,
      mode: row.mode,
      shipmentStatus: row.shipmentStatus,
      internalNote: row.internalNote,
      pendingPayoutApprovalId: row.pendingApprovalId,
    };
  }
}
