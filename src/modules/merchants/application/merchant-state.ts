import type { EntityManager } from 'typeorm';
import type { AuditRequestContext } from '../../../common/audit/audit.service';
import { EntityNotFoundException } from '../../../common/exceptions';
import { MerchantLimits, resolveLimits } from '../domain/merchant-limits';
import type { ApiKeyMode } from '../domain/api-key';
import { MerchantRole, ReviewItemKey } from '../domain/merchant.enums';
import { CURRENT_MERCHANT_TERMS_VERSION } from '../domain/merchant-terms';
import {
  buildChecklist,
  OnboardingChecklist,
} from '../domain/onboarding-checklist';
import { MerchantBankAccountEntity } from '../infrastructure/entities/merchant-bank-account.entity';
import { MerchantDirectorEntity } from '../infrastructure/entities/merchant-director.entity';
import { MerchantDocumentEntity } from '../infrastructure/entities/merchant-document.entity';
import { MerchantReviewItemEntity } from '../infrastructure/entities/merchant-review-item.entity';
import { MerchantEntity } from '../infrastructure/entities/merchant.entity';

// Who is acting on a merchant from the dashboard (resolved by MerchantGuard).
export interface MerchantActor {
  userId: string;
  merchantId: string;
  memberId: string;
  role: MerchantRole;
  // Step-up timestamp of the session (for actions that need it only
  // sometimes, e.g. live keys).
  reauthAt?: number;
  context: AuditRequestContext;
}

// Whoever calls an integrator endpoint: an API key, or a team member's
// dashboard session (mode from the Locoomo-Mode header).
export interface MerchantCaller {
  merchantId: string;
  mode: ApiKeyMode;
  via: 'api_key' | 'session';
  keyId: string | null;
  userId: string | null;
  context: AuditRequestContext;
}

export interface MerchantView {
  id: string;
  type: string;
  status: string;
  tradingName: string;
  legalName: string | null;
  category: string | null;
  storeUrl: string | null;
  expectedMonthlyVolume: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
  };
  cacNumber: string | null;
  tier: string | null;
  // Effective limits once approved (tier defaults + overrides), else null.
  limits: MerchantLimits | null;
  receiverCodeRelay: boolean;
  creationPaused: boolean;
  terms: {
    acceptedVersion: string | null;
    acceptedAt: string | null;
    currentVersion: string;
  };
  submittedAt: string | null;
  decidedAt: string | null;
  // Reviewer's note with the latest request-changes / reject.
  decisionNote: string | null;
  approvedAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorView {
  id: string;
  fullName: string;
  idType: string;
  idNumberLast4: string;
  createdAt: string;
}

export interface DocumentView {
  id: string;
  kind: string;
  uploadedAt: string;
}

export interface BankAccountView {
  bankCode: string;
  bankName: string;
  accountNumberLast4: string;
  accountName: string;
  verifiedAt: string;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function merchantView(merchant: MerchantEntity): MerchantView {
  return {
    id: merchant.id,
    type: merchant.type,
    status: merchant.status,
    tradingName: merchant.tradingName,
    legalName: merchant.legalName,
    category: merchant.category,
    storeUrl: merchant.storeUrl,
    expectedMonthlyVolume: merchant.expectedMonthlyVolume,
    contactEmail: merchant.contactEmail,
    contactPhone: merchant.contactPhone,
    address: {
      line1: merchant.addressLine1,
      line2: merchant.addressLine2,
      city: merchant.city,
      state: merchant.state,
    },
    cacNumber: merchant.cacNumber,
    tier: merchant.tier,
    limits: merchant.tier
      ? resolveLimits(merchant.tier, merchant.limitOverrides)
      : null,
    receiverCodeRelay: merchant.receiverCodeRelay,
    creationPaused: merchant.creationPaused,
    terms: {
      acceptedVersion: merchant.termsVersion,
      acceptedAt: iso(merchant.termsAcceptedAt),
      currentVersion: CURRENT_MERCHANT_TERMS_VERSION,
    },
    submittedAt: iso(merchant.submittedAt),
    decidedAt: iso(merchant.decidedAt),
    decisionNote: merchant.decisionNote,
    approvedAt: iso(merchant.approvedAt),
    suspendedAt: iso(merchant.suspendedAt),
    suspensionReason: merchant.suspensionReason,
    closedAt: iso(merchant.closedAt),
    createdAt: merchant.createdAt.toISOString(),
    updatedAt: merchant.updatedAt.toISOString(),
  };
}

export const directorView = (d: MerchantDirectorEntity): DirectorView => ({
  id: d.id,
  fullName: d.fullName,
  idType: d.idType,
  idNumberLast4: d.idNumberLast4,
  createdAt: d.createdAt.toISOString(),
});

export const documentView = (d: MerchantDocumentEntity): DocumentView => ({
  id: d.id,
  kind: d.kind,
  uploadedAt: d.createdAt.toISOString(),
});

export const bankAccountView = (
  b: MerchantBankAccountEntity,
): BankAccountView => ({
  bankCode: b.bankCode,
  bankName: b.bankName,
  accountNumberLast4: b.accountNumberLast4,
  accountName: b.accountName,
  verifiedAt: b.verifiedAt.toISOString(),
});

export interface OnboardingState {
  merchant: MerchantEntity;
  documents: MerchantDocumentEntity[];
  directors: MerchantDirectorEntity[];
  bankAccount: MerchantBankAccountEntity | null;
  reviews: MerchantReviewItemEntity[];
  checklist: OnboardingChecklist;
}

// Row lock on the merchant: every status change and every onboarding edit
// takes it, so a submit can't interleave with an edit, or an approve with
// a reject from a second admin tab.
export async function lockMerchant(
  manager: EntityManager,
  merchantId: string,
): Promise<MerchantEntity> {
  const merchant = await manager
    .getRepository(MerchantEntity)
    .createQueryBuilder('m')
    .setLock('pessimistic_write')
    .where('m.id = :merchantId', { merchantId })
    .getOne();
  if (!merchant) {
    throw new EntityNotFoundException('Merchant', merchantId);
  }
  return merchant;
}

export async function loadOnboardingState(
  manager: EntityManager,
  merchant: MerchantEntity,
): Promise<OnboardingState> {
  const [documents, directors, bankAccount, reviews] = await Promise.all([
    manager.find(MerchantDocumentEntity, {
      where: { merchantId: merchant.id },
      order: { createdAt: 'ASC' },
    }),
    manager.find(MerchantDirectorEntity, {
      where: { merchantId: merchant.id },
      order: { createdAt: 'ASC' },
    }),
    manager.findOneBy(MerchantBankAccountEntity, { merchantId: merchant.id }),
    manager.find(MerchantReviewItemEntity, {
      where: { merchantId: merchant.id },
    }),
  ]);
  const checklist = buildChecklist({
    type: merchant.type,
    legalName: merchant.legalName,
    category: merchant.category,
    contactEmail: merchant.contactEmail,
    contactPhone: merchant.contactPhone,
    addressLine1: merchant.addressLine1,
    city: merchant.city,
    state: merchant.state,
    expectedMonthlyVolume: merchant.expectedMonthlyVolume,
    cacNumber: merchant.cacNumber,
    documentKinds: documents.map((d) => d.kind),
    directorCount: directors.length,
    bankAccountVerified: !!bankAccount,
    termsVersion: merchant.termsVersion,
    reviews: new Map(
      reviews.map((r) => [r.key, { decision: r.decision, reason: r.reason }]),
    ),
  });
  return { merchant, documents, directors, bankAccount, reviews, checklist };
}

// The merchant edited a section: drop the reviewer's old verdict on it so
// it shows as "changed, waiting for review".
export async function clearReview(
  manager: EntityManager,
  merchantId: string,
  ...keys: ReviewItemKey[]
): Promise<void> {
  for (const key of keys) {
    await manager.delete(MerchantReviewItemEntity, { merchantId, key });
  }
}
