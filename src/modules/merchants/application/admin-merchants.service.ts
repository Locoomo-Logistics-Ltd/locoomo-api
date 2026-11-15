import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import { CloudinaryService } from '../../../common/cloudinary/cloudinary.service';
import { createSecretBox } from '../../../common/crypto/data-encryption-key';
import { SecretBox } from '../../../common/crypto/secret-box';
import { EntityNotFoundException } from '../../../common/exceptions';
import { Env } from '../../../config/env.validation';
import {
  InvalidMerchantTransitionException,
  NoRejectedItemsException,
  NotAHubException,
  NotApplicableToIndividualsException,
  OnboardingIncompleteException,
  ReviewHasRejectedItemsException,
} from '../domain/exceptions/merchant.exceptions';
import { defaultTierFor, MerchantLimits } from '../domain/merchant-limits';
import {
  MerchantStatus,
  ReviewDecision,
  ReviewItemKey,
} from '../domain/merchant.enums';
import { canTransition, UNDER_REVIEW } from '../domain/merchant-status';
import { nameMatchLevel, NameMatchLevel } from '../domain/name-match';
import {
  ChecklistItem,
  requiredSections,
} from '../domain/onboarding-checklist';
import { MerchantDirectorEntity } from '../infrastructure/entities/merchant-director.entity';
import { MerchantDocumentEntity } from '../infrastructure/entities/merchant-document.entity';
import { MerchantReviewItemEntity } from '../infrastructure/entities/merchant-review-item.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import {
  ApproveMerchantDto,
  ListMerchantsQueryDto,
  MerchantLimitsDto,
  RequestMerchantChangesDto,
  ReviewItemDecisionDto,
  UpdateMerchantSettingsDto,
} from '../interface/dto/admin-merchant.dto';
import { MerchantNotifierService } from './merchant-notifier.service';
import {
  BankAccountView,
  bankAccountView,
  DirectorView,
  directorView,
  DocumentView,
  documentView,
  loadOnboardingState,
  lockMerchant,
  MerchantView,
  merchantView,
} from './merchant-state';
import { MerchantTeamService, TeamView } from './merchant-team.service';
import { WebhookEmitterService } from './webhook-emitter.service';

export interface AdminActor {
  userId: string;
  context: AuditRequestContext;
}

export interface MerchantQueueItem {
  id: string;
  tradingName: string;
  legalName: string | null;
  type: string;
  status: string;
  tier: string | null;
  contactEmail: string | null;
  submittedAt: string | null;
  // Hours since submission while waiting for a decision (SLA: 1 working day).
  waitingHours: number | null;
  createdAt: string;
}

export interface AdminMerchantDetail {
  merchant: MerchantView;
  checklist: { items: ChecklistItem[]; readyToSubmit: boolean };
  reviews: {
    key: ReviewItemKey;
    decision: ReviewDecision;
    reason: string | null;
    decidedByUserId: string;
    decidedAt: string;
  }[];
  team: TeamView;
  directors: DirectorView[];
  documents: DocumentView[];
  bankAccount:
    | (BankAccountView & {
        nameMatch: { score: number; level: NameMatchLevel };
      })
    | null;
}

export interface ExpiringFile {
  url: string;
  expiresAt: string;
}

// Signed KYC file links live this long (plan §4.1).
const FILE_LINK_TTL_SECONDS = 300;

@Injectable()
export class AdminMerchantsService {
  private readonly kycBox: SecretBox;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly cloudinary: CloudinaryService,
    private readonly notifier: MerchantNotifierService,
    private readonly team: MerchantTeamService,
    private readonly webhooks: WebhookEmitterService,
    config: ConfigService<Env, true>,
  ) {
    this.kycBox = createSecretBox(config, 'merchant-kyc');
  }

  async list(query: ListMerchantsQueryDto): Promise<{
    items: MerchantQueueItem[];
    total: number;
  }> {
    const qb = this.dataSource
      .getRepository(MerchantEntity)
      .createQueryBuilder('m');
    if (query.status) {
      qb.andWhere('m.status = :status', { status: query.status });
    }
    if (query.q) {
      qb.andWhere(
        `(m."tradingName" ILIKE :q OR m."legalName" ILIKE :q OR m."contactEmail" ILIKE :q OR m."cacNumber" ILIKE :q)`,
        { q: `%${query.q.replace(/[%_\\]/g, '\\$&')}%` },
      );
    }
    // The review queue is first-come first-served; everything else newest first.
    if (query.status && UNDER_REVIEW.includes(query.status)) {
      qb.orderBy('m."submittedAt"', 'ASC');
    } else {
      qb.orderBy('m."createdAt"', 'DESC');
    }
    qb.addOrderBy('m.id', 'ASC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);
    const [rows, total] = await qb.getManyAndCount();
    const now = Date.now();
    return {
      total,
      items: rows.map((m) => ({
        id: m.id,
        tradingName: m.tradingName,
        legalName: m.legalName,
        type: m.type,
        status: m.status,
        tier: m.tier,
        contactEmail: m.contactEmail,
        submittedAt: m.submittedAt?.toISOString() ?? null,
        waitingHours:
          m.submittedAt && UNDER_REVIEW.includes(m.status)
            ? Math.floor((now - m.submittedAt.getTime()) / 3_600_000)
            : null,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async detail(merchantId: string): Promise<AdminMerchantDetail> {
    const manager = this.dataSource.manager;
    const merchant = await manager.findOneBy(MerchantEntity, {
      id: merchantId,
    });
    if (!merchant) {
      throw new EntityNotFoundException('Merchant', merchantId);
    }
    const state = await loadOnboardingState(manager, merchant);
    return {
      merchant: merchantView(merchant),
      checklist: state.checklist,
      reviews: state.reviews.map((r) => ({
        key: r.key,
        decision: r.decision,
        reason: r.reason,
        decidedByUserId: r.decidedByUserId,
        decidedAt: r.decidedAt.toISOString(),
      })),
      team: await this.team.team(merchant.id),
      directors: state.directors.map(directorView),
      documents: state.documents.map(documentView),
      bankAccount: state.bankAccount
        ? {
            ...bankAccountView(state.bankAccount),
            nameMatch: {
              score: state.bankAccount.nameMatchScore,
              level: nameMatchLevel(state.bankAccount.nameMatchScore),
            },
          }
        : null,
    };
  }

  // Every view of a KYC file is audited (NDPA, plan §11.6).
  async documentLink(
    admin: AdminActor,
    merchantId: string,
    documentId: string,
  ): Promise<ExpiringFile> {
    const document = await this.dataSource.manager.findOneBy(
      MerchantDocumentEntity,
      { id: documentId, merchantId },
    );
    if (!document) {
      throw new EntityNotFoundException('Document', documentId);
    }
    const link = this.cloudinary.getExpiringDownloadUrl(
      document.publicId,
      FILE_LINK_TTL_SECONDS,
    );
    await this.audit.record({
      actor: { type: 'user', id: admin.userId, role: 'admin' },
      action: 'merchant.kyc_document_viewed',
      merchantId,
      target: { type: 'merchant_document', id: document.id },
      metadata: { kind: document.kind },
      context: admin.context,
    });
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  async directorIdentity(
    admin: AdminActor,
    merchantId: string,
    directorId: string,
  ): Promise<{
    fullName: string;
    idType: string;
    idNumber: string;
    idDocument: ExpiringFile;
  }> {
    const director = await this.dataSource.manager.findOneBy(
      MerchantDirectorEntity,
      { id: directorId, merchantId },
    );
    if (!director) {
      throw new EntityNotFoundException('Director', directorId);
    }
    const link = this.cloudinary.getExpiringDownloadUrl(
      director.idDocumentPublicId,
      FILE_LINK_TTL_SECONDS,
    );
    await this.audit.record({
      actor: { type: 'user', id: admin.userId, role: 'admin' },
      action: 'merchant.kyc_identity_viewed',
      merchantId,
      target: { type: 'merchant_director', id: director.id },
      metadata: { idType: director.idType },
      context: admin.context,
    });
    return {
      fullName: director.fullName,
      idType: director.idType,
      idNumber: this.kycBox.open(director.idNumberSealed).toString('utf8'),
      idDocument: { url: link.url, expiresAt: link.expiresAt.toISOString() },
    };
  }

  async review(
    admin: AdminActor,
    merchantId: string,
    items: ReviewItemDecisionDto[],
  ): Promise<AdminMerchantDetail> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, merchantId);
      this.assertUnderReview(merchant, MerchantStatus.IN_REVIEW);
      await this.recordDecisions(manager, admin, merchant, items);
      if (merchant.status === MerchantStatus.SUBMITTED) {
        await this.transition(
          manager,
          admin,
          merchant,
          MerchantStatus.IN_REVIEW,
          'review_started',
        );
      }
    });
    return this.detail(merchantId);
  }

  async approve(
    admin: AdminActor,
    merchantId: string,
    dto: ApproveMerchantDto,
  ): Promise<AdminMerchantDetail> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, merchantId);
      this.assertUnderReview(merchant, MerchantStatus.APPROVED);
      const { checklist, reviews } = await loadOnboardingState(
        manager,
        merchant,
      );
      const rejected = reviews
        .filter((r) => r.decision === ReviewDecision.REJECTED)
        .map((r) => r.key);
      if (rejected.length > 0) {
        throw new ReviewHasRejectedItemsException(rejected);
      }
      const incomplete = checklist.items.filter((item) => !item.complete);
      if (incomplete.length > 0) {
        throw new OnboardingIncompleteException(
          incomplete.map(({ key, missing }) => ({ key, missing })),
        );
      }
      // Approving accepts every section not explicitly decided yet.
      const decided = new Set(reviews.map((r) => r.key));
      await this.recordDecisions(
        manager,
        admin,
        merchant,
        requiredSections(merchant.type)
          .filter((key) => !decided.has(key))
          .map((key) => ({ key, decision: ReviewDecision.ACCEPTED })),
      );

      merchant.tier = dto.tier ?? defaultTierFor(merchant.type);
      merchant.limitOverrides = this.limitOverrides(dto.limits);
      merchant.approvedAt = new Date();
      merchant.decisionNote = null;
      await this.transition(
        manager,
        admin,
        merchant,
        MerchantStatus.APPROVED,
        'approved',
        {
          tier: merchant.tier,
          limitOverrides: merchant.limitOverrides,
        },
      );
      await this.notifier.statusChanged(merchant, 'approved', manager);
    });
    return this.detail(merchantId);
  }

  async requestChanges(
    admin: AdminActor,
    merchantId: string,
    dto: RequestMerchantChangesDto,
  ): Promise<AdminMerchantDetail> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, merchantId);
      this.assertUnderReview(merchant, MerchantStatus.CHANGES_REQUESTED);
      if (dto.items?.length) {
        await this.recordDecisions(manager, admin, merchant, dto.items);
      }
      const rejected = await manager.find(MerchantReviewItemEntity, {
        where: { merchantId, decision: ReviewDecision.REJECTED },
      });
      if (rejected.length === 0) {
        throw new NoRejectedItemsException();
      }
      merchant.decisionNote = dto.note ?? null;
      await this.transition(
        manager,
        admin,
        merchant,
        MerchantStatus.CHANGES_REQUESTED,
        'changes_requested',
        { rejected: rejected.map((r) => r.key), note: dto.note ?? null },
      );
      await this.notifier.statusChanged(
        merchant,
        'changes_requested',
        manager,
        {
          reason: dto.note ?? null,
          rejectedSections: rejected.map((r) => ({
            key: r.key,
            reason: r.reason,
          })),
        },
      );
    });
    return this.detail(merchantId);
  }

  async reject(
    admin: AdminActor,
    merchantId: string,
    reason: string,
  ): Promise<AdminMerchantDetail> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, merchantId);
      this.assertUnderReview(merchant, MerchantStatus.REJECTED);
      merchant.decisionNote = reason;
      await this.transition(
        manager,
        admin,
        merchant,
        MerchantStatus.REJECTED,
        'rejected',
        {
          reason,
        },
      );
      await this.notifier.statusChanged(merchant, 'rejected', manager, {
        reason,
      });
    });
    return this.detail(merchantId);
  }

  async suspend(
    admin: AdminActor,
    merchantId: string,
    reason: string,
  ): Promise<AdminMerchantDetail> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, merchantId);
      merchant.statusBeforeSuspension = merchant.status;
      merchant.suspendedAt = new Date();
      merchant.suspensionReason = reason;
      await this.transition(
        manager,
        admin,
        merchant,
        MerchantStatus.SUSPENDED,
        'suspended',
        {
          reason,
        },
      );
      await this.notifier.statusChanged(merchant, 'suspended', manager, {
        reason,
      });
    });
    return this.detail(merchantId);
  }

  async reinstate(
    admin: AdminActor,
    merchantId: string,
  ): Promise<AdminMerchantDetail> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, merchantId);
      if (merchant.status !== MerchantStatus.SUSPENDED) {
        throw new InvalidMerchantTransitionException(
          merchant.status,
          MerchantStatus.APPROVED,
        );
      }
      const target = merchant.statusBeforeSuspension ?? MerchantStatus.APPROVED;
      merchant.statusBeforeSuspension = null;
      merchant.suspendedAt = null;
      merchant.suspensionReason = null;
      await this.transition(manager, admin, merchant, target, 'reinstated');
      await this.notifier.statusChanged(merchant, 'reinstated', manager);
    });
    return this.detail(merchantId);
  }

  async updateSettings(
    admin: AdminActor,
    merchantId: string,
    dto: UpdateMerchantSettingsDto,
  ): Promise<AdminMerchantDetail> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, merchantId);
      if (merchant.status === MerchantStatus.CLOSED) {
        throw new InvalidMerchantTransitionException(
          merchant.status,
          merchant.status,
        );
      }
      const before = this.settings(merchant);
      if (dto.receiverCodeRelay !== undefined) {
        merchant.receiverCodeRelay = dto.receiverCodeRelay;
      }
      if (dto.creationPaused !== undefined) {
        merchant.creationPaused = dto.creationPaused;
      }
      if (dto.tier !== undefined) {
        merchant.tier = dto.tier;
      }
      if (dto.limits !== undefined) {
        merchant.limitOverrides = this.limitOverrides(dto.limits);
      }
      if (dto.hubNodeId !== undefined) {
        if (dto.hubNodeId !== null) {
          const [hub] = await manager.query<{ id: string }[]>(
            `SELECT id FROM nodes WHERE id = $1 AND "isHub" AND status = 'active'`,
            [dto.hubNodeId],
          );
          if (!hub) {
            throw new NotAHubException();
          }
        }
        merchant.hubNodeId = dto.hubNodeId;
      }
      await manager.save(merchant);
      await this.audit.record(
        {
          actor: { type: 'user', id: admin.userId, role: 'admin' },
          action: 'merchant.settings_updated',
          merchantId,
          target: { type: 'merchant', id: merchantId },
          before,
          after: this.settings(merchant),
          context: admin.context,
        },
        manager,
      );
    });
    return this.detail(merchantId);
  }

  private async recordDecisions(
    manager: EntityManager,
    admin: AdminActor,
    merchant: MerchantEntity,
    items: { key: ReviewItemKey; decision: ReviewDecision; reason?: string }[],
  ): Promise<void> {
    const applicable = requiredSections(merchant.type);
    for (const item of items) {
      if (!applicable.includes(item.key)) {
        throw new NotApplicableToIndividualsException(item.key);
      }
    }
    if (items.length === 0) {
      return;
    }
    const decidedAt = new Date();
    await manager.upsert(
      MerchantReviewItemEntity,
      items.map((item) => ({
        merchantId: merchant.id,
        key: item.key,
        decision: item.decision,
        reason: item.reason ?? null,
        decidedByUserId: admin.userId,
        decidedAt,
      })),
      ['merchantId', 'key'],
    );
    await this.audit.record(
      {
        actor: { type: 'user', id: admin.userId, role: 'admin' },
        action: 'merchant.review_recorded',
        merchantId: merchant.id,
        target: { type: 'merchant', id: merchant.id },
        metadata: {
          items: items.map(({ key, decision, reason }) => ({
            key,
            decision,
            reason: reason ?? null,
          })),
        },
        context: admin.context,
      },
      manager,
    );
  }

  private async transition(
    manager: EntityManager,
    admin: AdminActor,
    merchant: MerchantEntity,
    to: MerchantStatus,
    action: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!canTransition(merchant.status, to)) {
      throw new InvalidMerchantTransitionException(merchant.status, to);
    }
    const from = merchant.status;
    merchant.status = to;
    if (
      to === MerchantStatus.APPROVED ||
      to === MerchantStatus.CHANGES_REQUESTED ||
      to === MerchantStatus.REJECTED
    ) {
      merchant.decidedAt = new Date();
      merchant.decidedByUserId = admin.userId;
    }
    await manager.save(merchant);
    await this.audit.record(
      {
        actor: { type: 'user', id: admin.userId, role: 'admin' },
        action: `merchant.${action}`,
        merchantId: merchant.id,
        target: { type: 'merchant', id: merchant.id },
        before: { status: from },
        after: { status: to },
        metadata: metadata ?? null,
        context: admin.context,
      },
      manager,
    );
    await this.webhooks.merchantStatusChanged(manager, merchant.id, from, to);
  }

  private assertUnderReview(
    merchant: MerchantEntity,
    to: MerchantStatus,
  ): void {
    if (!UNDER_REVIEW.includes(merchant.status)) {
      throw new InvalidMerchantTransitionException(merchant.status, to);
    }
  }

  private limitOverrides(
    limits: MerchantLimitsDto | undefined,
  ): Partial<MerchantLimits> | null {
    if (!limits) {
      return null;
    }
    const entries = Object.entries(limits).filter(
      ([, value]) => value !== undefined,
    );
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }

  private settings(merchant: MerchantEntity): Record<string, unknown> {
    return {
      receiverCodeRelay: merchant.receiverCodeRelay,
      creationPaused: merchant.creationPaused,
      tier: merchant.tier,
      limitOverrides: merchant.limitOverrides,
      hubNodeId: merchant.hubNodeId,
    };
  }
}
