import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AuditRequestContext,
  AuditService,
} from '../../../common/audit/audit.service';
import {
  CloudinaryService,
  UploadSignature,
} from '../../../common/cloudinary/cloudinary.service';
import { createSecretBox } from '../../../common/crypto/data-encryption-key';
import { SecretBox } from '../../../common/crypto/secret-box';
import { isUniqueViolation } from '../../../common/database/is-unique-violation.util';
import { EntityNotFoundException } from '../../../common/exceptions';
import { Env } from '../../../config/env.validation';
import {
  AlreadyAMerchantMemberException,
  DirectorLimitReachedException,
  InvalidMerchantTransitionException,
  MerchantDetailsLockedException,
  MerchantNotEditableException,
  NotApplicableToIndividualsException,
  OnboardingIncompleteException,
  TermsVersionOutdatedException,
  UploadNotFoundException,
} from '../domain/exceptions/merchant.exceptions';
import {
  MerchantDocumentKind,
  MerchantRole,
  MerchantStatus,
  MerchantType,
  ReviewDecision,
  ReviewItemKey,
} from '../domain/merchant.enums';
import {
  MerchantPermission,
  ROLE_PERMISSIONS,
} from '../domain/merchant-permissions';
import {
  canTransition,
  CONTACT_EDITABLE,
  ONBOARDING_EDITABLE,
} from '../domain/merchant-status';
import { CURRENT_MERCHANT_TERMS_VERSION } from '../domain/merchant-terms';
import { ChecklistItem } from '../domain/onboarding-checklist';
import { MerchantDirectorEntity } from '../infrastructure/entities/merchant-director.entity';
import { MerchantDocumentEntity } from '../infrastructure/entities/merchant-document.entity';
import { MerchantInviteEntity } from '../infrastructure/entities/merchant-invite.entity';
import { MerchantMemberEntity } from '../infrastructure/entities/merchant-member.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';
import {
  AddDirectorDto,
  CreateMerchantDto,
  UpdateMerchantProfileDto,
} from '../interface/dto/merchant-account.dto';
import { MerchantContextService } from './merchant-context.service';
import { MerchantNotifierService } from './merchant-notifier.service';
import { WebhookEmitterService } from './webhook-emitter.service';
import {
  BankAccountView,
  bankAccountView,
  clearReview,
  DirectorView,
  directorView,
  DocumentView,
  documentView,
  loadOnboardingState,
  lockMerchant,
  MerchantActor,
  MerchantView,
  merchantView,
} from './merchant-state';

export interface MerchantAccountOverview {
  merchant: MerchantView;
  me: {
    memberId: string;
    role: MerchantRole;
    permissions: MerchantPermission[];
  };
  onboarding: {
    items: ChecklistItem[];
    readyToSubmit: boolean;
    // Whether the team can edit onboarding details right now.
    editable: boolean;
  };
  documents: DocumentView[];
  directors: DirectorView[];
  bankAccount: BankAccountView | null;
}

const MAX_DIRECTORS = 10;
// Fields that identify the business; frozen once approved.
const IDENTITY_FIELDS = ['tradingName', 'legalName', 'cacNumber'] as const;

// The merchant's own account: creation, onboarding details, submission and
// closure. Team and bank account live in their own services.
@Injectable()
export class MerchantAccountService {
  private readonly kycBox: SecretBox;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly cloudinary: CloudinaryService,
    private readonly contextService: MerchantContextService,
    private readonly notifier: MerchantNotifierService,
    private readonly webhooks: WebhookEmitterService,
    config: ConfigService<Env, true>,
  ) {
    this.kycBox = createSecretBox(config, 'merchant-kyc');
  }

  async create(
    userId: string,
    dto: CreateMerchantDto,
    context: AuditRequestContext,
  ): Promise<MerchantAccountOverview> {
    if (await this.contextService.membershipFor(userId)) {
      throw new AlreadyAMerchantMemberException();
    }
    let merchantId: string;
    try {
      merchantId = await this.dataSource.transaction(async (manager) => {
        const merchant = await manager.save(
          manager.create(MerchantEntity, {
            type: dto.type,
            status: MerchantStatus.DRAFT,
            tradingName: dto.tradingName,
            createdByUserId: userId,
          }),
        );
        await manager.save(
          manager.create(MerchantMemberEntity, {
            merchantId: merchant.id,
            userId,
            role: MerchantRole.OWNER,
            invitedByUserId: null,
          }),
        );
        await this.audit.record(
          {
            actor: { type: 'user', id: userId },
            action: 'merchant.created',
            merchantId: merchant.id,
            target: { type: 'merchant', id: merchant.id },
            after: { type: dto.type, tradingName: dto.tradingName },
            context,
          },
          manager,
        );
        return merchant.id;
      });
    } catch (error) {
      // Two tabs creating at once: the unique userId index lets one win.
      if (isUniqueViolation(error)) {
        throw new AlreadyAMerchantMemberException();
      }
      throw error;
    }
    await this.contextService.bust(userId);
    const membership = await this.contextService.membershipFor(userId);
    return this.overview(merchantId, membership!.memberId, MerchantRole.OWNER);
  }

  async overview(
    merchantId: string,
    memberId: string,
    role: MerchantRole,
  ): Promise<MerchantAccountOverview> {
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
      me: { memberId, role, permissions: [...ROLE_PERMISSIONS[role]] },
      onboarding: {
        items: state.checklist.items,
        readyToSubmit: state.checklist.readyToSubmit,
        editable: ONBOARDING_EDITABLE.includes(merchant.status),
      },
      documents: state.documents.map(documentView),
      directors: state.directors.map(directorView),
      bankAccount: state.bankAccount
        ? bankAccountView(state.bankAccount)
        : null,
    };
  }

  async updateProfile(
    actor: MerchantActor,
    dto: UpdateMerchantProfileDto,
  ): Promise<MerchantAccountOverview> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      if (!CONTACT_EDITABLE.includes(merchant.status)) {
        throw new MerchantNotEditableException(merchant.status);
      }
      if (merchant.status === MerchantStatus.APPROVED) {
        const locked = IDENTITY_FIELDS.filter(
          (field) => dto[field] !== undefined && dto[field] !== merchant[field],
        );
        if (locked.length > 0) {
          throw new MerchantDetailsLockedException([...locked]);
        }
      }
      if (
        dto.cacNumber !== undefined &&
        merchant.type === MerchantType.INDIVIDUAL
      ) {
        throw new NotApplicableToIndividualsException('cacNumber');
      }

      const before = this.profileFields(merchant);
      const changes: Partial<MerchantEntity> = {
        ...(dto.tradingName !== undefined && { tradingName: dto.tradingName }),
        ...(dto.legalName !== undefined && { legalName: dto.legalName }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.storeUrl !== undefined && { storeUrl: dto.storeUrl }),
        ...(dto.expectedMonthlyVolume !== undefined && {
          expectedMonthlyVolume: dto.expectedMonthlyVolume,
        }),
        ...(dto.contactEmail !== undefined && {
          contactEmail: dto.contactEmail,
        }),
        ...(dto.contactPhone !== undefined && {
          contactPhone: dto.contactPhone,
        }),
        ...(dto.address !== undefined && {
          addressLine1: dto.address.line1,
          addressLine2: dto.address.line2 ?? null,
          city: dto.address.city,
          state: dto.address.state,
        }),
        ...(dto.cacNumber !== undefined && { cacNumber: dto.cacNumber }),
      };
      Object.assign(merchant, changes);
      await manager.save(merchant);

      if (ONBOARDING_EDITABLE.includes(merchant.status)) {
        const profileTouched = Object.keys(dto).some(
          (field) => field !== 'cacNumber',
        );
        await clearReview(
          manager,
          merchant.id,
          ...(profileTouched ? [ReviewItemKey.PROFILE] : []),
          ...(dto.cacNumber !== undefined
            ? [ReviewItemKey.BUSINESS_REGISTRATION]
            : []),
        );
      }
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.profile_updated',
          merchantId: merchant.id,
          target: { type: 'merchant', id: merchant.id },
          before,
          after: this.profileFields(merchant),
          context: actor.context,
        },
        manager,
      );
    });
    return this.overview(actor.merchantId, actor.memberId, actor.role);
  }

  // Signed direct-to-Cloudinary upload into the merchant's own folder.
  async uploadSignature(actor: MerchantActor): Promise<UploadSignature> {
    const merchant = await this.getMerchant(actor.merchantId);
    if (!ONBOARDING_EDITABLE.includes(merchant.status)) {
      throw new MerchantNotEditableException(merchant.status);
    }
    return this.cloudinary.generateUploadSignature(this.folder(merchant.id));
  }

  async putDocument(
    actor: MerchantActor,
    kind: MerchantDocumentKind,
    publicId: string,
  ): Promise<DocumentView> {
    await this.assertOwnUpload(actor.merchantId, publicId);
    return this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      this.assertOnboardingEditable(merchant);
      if (
        merchant.type === MerchantType.INDIVIDUAL &&
        kind !== MerchantDocumentKind.PROOF_OF_ADDRESS
      ) {
        throw new NotApplicableToIndividualsException(`documents.${kind}`);
      }
      const repo = manager.getRepository(MerchantDocumentEntity);
      const existing = await repo.findOneBy({ merchantId: merchant.id, kind });
      // Replace rather than update: uploadedAt (createdAt) must move too.
      if (existing) {
        await repo.delete(existing.id);
      }
      const saved = await repo.save(
        repo.create({
          merchantId: merchant.id,
          kind,
          publicId,
          uploadedByUserId: actor.userId,
        }),
      );
      await clearReview(
        manager,
        merchant.id,
        kind === MerchantDocumentKind.PROOF_OF_ADDRESS
          ? ReviewItemKey.PROFILE
          : ReviewItemKey.BUSINESS_REGISTRATION,
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.document_uploaded',
          merchantId: merchant.id,
          target: { type: 'merchant_document', id: saved.id },
          metadata: { kind, replaced: !!existing },
          context: actor.context,
        },
        manager,
      );
      return documentView(saved);
    });
  }

  async addDirector(
    actor: MerchantActor,
    dto: AddDirectorDto,
  ): Promise<DirectorView> {
    await this.assertOwnUpload(actor.merchantId, dto.idDocumentPublicId);
    return this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      this.assertOnboardingEditable(merchant);
      const limit =
        merchant.type === MerchantType.INDIVIDUAL ? 1 : MAX_DIRECTORS;
      const count = await manager.countBy(MerchantDirectorEntity, {
        merchantId: merchant.id,
      });
      if (count >= limit) {
        throw new DirectorLimitReachedException(limit);
      }
      const saved = await manager.save(
        manager.create(MerchantDirectorEntity, {
          merchantId: merchant.id,
          fullName: dto.fullName,
          idType: dto.idType,
          idNumberSealed: this.kycBox.seal(Buffer.from(dto.idNumber, 'utf8')),
          idNumberLast4: dto.idNumber.slice(-4),
          idDocumentPublicId: dto.idDocumentPublicId,
          createdByUserId: actor.userId,
        }),
      );
      await clearReview(manager, merchant.id, ReviewItemKey.DIRECTORS);
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.director_added',
          merchantId: merchant.id,
          target: { type: 'merchant_director', id: saved.id },
          after: {
            fullName: saved.fullName,
            idType: saved.idType,
            idNumberLast4: saved.idNumberLast4,
          },
          context: actor.context,
        },
        manager,
      );
      return directorView(saved);
    });
  }

  async removeDirector(
    actor: MerchantActor,
    directorId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      this.assertOnboardingEditable(merchant);
      const director = await manager.findOneBy(MerchantDirectorEntity, {
        id: directorId,
        merchantId: merchant.id,
      });
      if (!director) {
        throw new EntityNotFoundException('Director', directorId);
      }
      await manager.delete(MerchantDirectorEntity, director.id);
      await clearReview(manager, merchant.id, ReviewItemKey.DIRECTORS);
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.director_removed',
          merchantId: merchant.id,
          target: { type: 'merchant_director', id: director.id },
          before: { fullName: director.fullName, idType: director.idType },
          context: actor.context,
        },
        manager,
      );
    });
  }

  async acceptTerms(
    actor: MerchantActor,
    version: string,
  ): Promise<MerchantAccountOverview> {
    if (version !== CURRENT_MERCHANT_TERMS_VERSION) {
      throw new TermsVersionOutdatedException(CURRENT_MERCHANT_TERMS_VERSION);
    }
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      // Accepting newer terms is always allowed while the account is live,
      // so a bump never locks an approved merchant out.
      if (
        !CONTACT_EDITABLE.includes(merchant.status) &&
        merchant.status !== MerchantStatus.SUSPENDED
      ) {
        throw new MerchantNotEditableException(merchant.status);
      }
      merchant.termsVersion = version;
      merchant.termsAcceptedAt = new Date();
      merchant.termsAcceptedByUserId = actor.userId;
      await manager.save(merchant);
      if (ONBOARDING_EDITABLE.includes(merchant.status)) {
        await clearReview(manager, merchant.id, ReviewItemKey.TERMS);
      }
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.terms_accepted',
          merchantId: merchant.id,
          target: { type: 'merchant', id: merchant.id },
          metadata: { version },
          context: actor.context,
        },
        manager,
      );
    });
    return this.overview(actor.merchantId, actor.memberId, actor.role);
  }

  async submit(actor: MerchantActor): Promise<MerchantAccountOverview> {
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      if (!canTransition(merchant.status, MerchantStatus.SUBMITTED)) {
        throw new InvalidMerchantTransitionException(
          merchant.status,
          MerchantStatus.SUBMITTED,
        );
      }
      const { checklist } = await loadOnboardingState(manager, merchant);
      if (!checklist.readyToSubmit) {
        throw new OnboardingIncompleteException(
          checklist.items
            .filter(
              (item) =>
                !item.complete ||
                item.review?.decision === ReviewDecision.REJECTED,
            )
            .map((item) => ({
              key: item.key,
              missing: item.complete
                ? ['changes requested by reviewer']
                : item.missing,
            })),
        );
      }
      const from = merchant.status;
      merchant.status = MerchantStatus.SUBMITTED;
      merchant.submittedAt = new Date();
      await manager.save(merchant);
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.submitted',
          merchantId: merchant.id,
          target: { type: 'merchant', id: merchant.id },
          before: { status: from },
          after: { status: merchant.status },
          context: actor.context,
        },
        manager,
      );
      await this.notifier.statusChanged(merchant, 'submitted', manager);
      await this.webhooks.merchantStatusChanged(
        manager,
        merchant.id,
        from,
        merchant.status,
      );
      await this.notifier.newSubmissionForReviewers(merchant, manager);
    });
    return this.overview(actor.merchantId, actor.memberId, actor.role);
  }

  // Owner closes the account. Nothing can be in flight before M4 (no live
  // shipments or wallet yet); M4 adds the in-flight / balance checks and
  // the maker-checker refund here (plan §2.1).
  async close(actor: MerchantActor): Promise<void> {
    let memberUserIds: string[] = [];
    await this.dataSource.transaction(async (manager) => {
      const merchant = await lockMerchant(manager, actor.merchantId);
      if (!canTransition(merchant.status, MerchantStatus.CLOSED)) {
        throw new InvalidMerchantTransitionException(
          merchant.status,
          MerchantStatus.CLOSED,
        );
      }
      const from = merchant.status;
      // Email first: the team is removed below.
      await this.notifier.statusChanged(merchant, 'closed', manager);

      const members = await manager.findBy(MerchantMemberEntity, {
        merchantId: merchant.id,
      });
      memberUserIds = members.map((member) => member.userId);
      await manager.delete(MerchantMemberEntity, { merchantId: merchant.id });
      await manager
        .createQueryBuilder()
        .update(MerchantInviteEntity)
        .set({ revokedAt: () => 'now()' })
        .where(
          '"merchantId" = :id AND "acceptedAt" IS NULL AND "revokedAt" IS NULL',
          {
            id: merchant.id,
          },
        )
        .execute();

      merchant.status = MerchantStatus.CLOSED;
      merchant.closedAt = new Date();
      await manager.save(merchant);
      await this.webhooks.merchantStatusChanged(
        manager,
        merchant.id,
        from,
        merchant.status,
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'merchant.closed',
          merchantId: merchant.id,
          target: { type: 'merchant', id: merchant.id },
          before: { status: from },
          after: { status: merchant.status },
          metadata: {
            removedMembers: members.map((m) => ({
              userId: m.userId,
              role: m.role,
            })),
          },
          context: actor.context,
        },
        manager,
      );
    });
    await this.contextService.bust(...memberUserIds);
  }

  private folder(merchantId: string): string {
    return `merchants/${merchantId}/kyc`;
  }

  // The signature only proves an upload *could* happen; check it did, and
  // that the file is in this merchant's folder, not someone else's.
  private async assertOwnUpload(
    merchantId: string,
    publicId: string,
  ): Promise<void> {
    if (
      !publicId.startsWith(`${this.folder(merchantId)}/`) ||
      !(await this.cloudinary.resourceExists(publicId))
    ) {
      throw new UploadNotFoundException();
    }
  }

  private assertOnboardingEditable(merchant: MerchantEntity): void {
    if (ONBOARDING_EDITABLE.includes(merchant.status)) {
      return;
    }
    if (merchant.status === MerchantStatus.APPROVED) {
      throw new MerchantDetailsLockedException(['documents', 'directors']);
    }
    throw new MerchantNotEditableException(merchant.status);
  }

  private async getMerchant(merchantId: string): Promise<MerchantEntity> {
    const merchant = await this.dataSource.manager.findOneBy(MerchantEntity, {
      id: merchantId,
    });
    if (!merchant) {
      throw new EntityNotFoundException('Merchant', merchantId);
    }
    return merchant;
  }

  private profileFields(merchant: MerchantEntity): Record<string, unknown> {
    return {
      tradingName: merchant.tradingName,
      legalName: merchant.legalName,
      category: merchant.category,
      storeUrl: merchant.storeUrl,
      expectedMonthlyVolume: merchant.expectedMonthlyVolume,
      contactEmail: merchant.contactEmail,
      contactPhone: merchant.contactPhone,
      addressLine1: merchant.addressLine1,
      addressLine2: merchant.addressLine2,
      city: merchant.city,
      state: merchant.state,
      cacNumber: merchant.cacNumber,
    };
  }
}
