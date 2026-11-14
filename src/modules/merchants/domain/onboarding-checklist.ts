import {
  MerchantDocumentKind,
  MerchantType,
  ReviewDecision,
  ReviewItemKey,
} from './merchant.enums';
import { CURRENT_MERCHANT_TERMS_VERSION } from './merchant-terms';

export interface OnboardingSnapshot {
  type: MerchantType;
  legalName: string | null;
  category: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  expectedMonthlyVolume: string | null;
  cacNumber: string | null;
  documentKinds: readonly MerchantDocumentKind[];
  directorCount: number;
  bankAccountVerified: boolean;
  termsVersion: string | null;
  reviews: ReadonlyMap<
    ReviewItemKey,
    { decision: ReviewDecision; reason: string | null }
  >;
}

export interface ChecklistItem {
  key: ReviewItemKey;
  complete: boolean;
  // Field names still needed, for the "what's left" hint under each card.
  missing: string[];
  // The reviewer's latest decision on this section. Cleared as soon as the
  // team edits the section, so a rejected item shows as "changed, waiting
  // for review" rather than still rejected.
  review: { decision: ReviewDecision; reason: string | null } | null;
}

export interface OnboardingChecklist {
  items: ChecklistItem[];
  // Every section complete and no rejected section left unchanged.
  readyToSubmit: boolean;
}

// The sections a merchant of this type must complete (plan §4.1).
export function requiredSections(type: MerchantType): ReviewItemKey[] {
  return [
    ReviewItemKey.PROFILE,
    ...(type === MerchantType.BUSINESS
      ? [ReviewItemKey.BUSINESS_REGISTRATION]
      : []),
    ReviewItemKey.DIRECTORS,
    ReviewItemKey.BANK_ACCOUNT,
    ReviewItemKey.TERMS,
  ];
}

export function buildChecklist(
  snapshot: OnboardingSnapshot,
): OnboardingChecklist {
  const missingFor = (key: ReviewItemKey): string[] => {
    switch (key) {
      case ReviewItemKey.PROFILE: {
        const fields: [string, unknown][] = [
          ['legalName', snapshot.legalName],
          ['category', snapshot.category],
          ['contactEmail', snapshot.contactEmail],
          ['contactPhone', snapshot.contactPhone],
          ['address.line1', snapshot.addressLine1],
          ['address.city', snapshot.city],
          ['address.state', snapshot.state],
          ['expectedMonthlyVolume', snapshot.expectedMonthlyVolume],
        ];
        return fields.filter(([, value]) => !value).map(([name]) => name);
      }
      case ReviewItemKey.BUSINESS_REGISTRATION:
        return [
          ...(snapshot.cacNumber ? [] : ['cacNumber']),
          ...(snapshot.documentKinds.includes(
            MerchantDocumentKind.CAC_CERTIFICATE,
          )
            ? []
            : ['documents.cac_certificate']),
        ];
      case ReviewItemKey.DIRECTORS:
        return snapshot.directorCount > 0 ? [] : ['directors'];
      case ReviewItemKey.BANK_ACCOUNT:
        return snapshot.bankAccountVerified ? [] : ['bankAccount'];
      case ReviewItemKey.TERMS:
        return snapshot.termsVersion === CURRENT_MERCHANT_TERMS_VERSION
          ? []
          : ['terms'];
    }
  };

  const items = requiredSections(snapshot.type).map((key) => {
    const missing = missingFor(key);
    return {
      key,
      complete: missing.length === 0,
      missing,
      review: snapshot.reviews.get(key) ?? null,
    };
  });

  return {
    items,
    readyToSubmit: items.every(
      (item) =>
        item.complete && item.review?.decision !== ReviewDecision.REJECTED,
    ),
  };
}
