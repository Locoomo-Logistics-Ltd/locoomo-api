import {
  MerchantDocumentKind,
  MerchantType,
  ReviewDecision,
  ReviewItemKey,
} from './merchant.enums';
import { CURRENT_MERCHANT_TERMS_VERSION } from './merchant-terms';
import { buildChecklist, OnboardingSnapshot } from './onboarding-checklist';

const complete: OnboardingSnapshot = {
  type: MerchantType.BUSINESS,
  legalName: 'Ada Stores Ltd',
  category: 'fashion',
  contactEmail: 'ops@ada.test',
  contactPhone: '+2348031234567',
  addressLine1: '1 Allen Avenue',
  city: 'Ikeja',
  state: 'Lagos',
  expectedMonthlyVolume: 'up_to_1k',
  cacNumber: 'RC1234567',
  documentKinds: [MerchantDocumentKind.CAC_CERTIFICATE],
  directorCount: 1,
  bankAccountVerified: true,
  termsVersion: CURRENT_MERCHANT_TERMS_VERSION,
  reviews: new Map(),
};

describe('onboarding checklist', () => {
  it('is ready when every section is complete', () => {
    const checklist = buildChecklist(complete);
    expect(checklist.readyToSubmit).toBe(true);
    expect(checklist.items.map((item) => item.key)).toEqual([
      'profile',
      'business_registration',
      'directors',
      'bank_account',
      'terms',
    ]);
  });

  it('skips business registration for individual sellers', () => {
    const checklist = buildChecklist({
      ...complete,
      type: MerchantType.INDIVIDUAL,
      cacNumber: null,
      documentKinds: [],
    });
    expect(checklist.readyToSubmit).toBe(true);
    expect(checklist.items.map((item) => item.key)).not.toContain(
      'business_registration',
    );
  });

  it('lists what is missing per section', () => {
    const checklist = buildChecklist({
      ...complete,
      legalName: null,
      city: null,
      documentKinds: [],
      termsVersion: '2020-01-01',
    });
    expect(checklist.readyToSubmit).toBe(false);
    const byKey = new Map(checklist.items.map((item) => [item.key, item]));
    expect(byKey.get(ReviewItemKey.PROFILE)?.missing).toEqual([
      'legalName',
      'address.city',
    ]);
    expect(byKey.get(ReviewItemKey.BUSINESS_REGISTRATION)?.missing).toEqual([
      'documents.cac_certificate',
    ]);
    expect(byKey.get(ReviewItemKey.TERMS)?.complete).toBe(false);
  });

  it('is not ready while a rejected section is unchanged', () => {
    const checklist = buildChecklist({
      ...complete,
      reviews: new Map([
        [
          ReviewItemKey.BANK_ACCOUNT,
          { decision: ReviewDecision.REJECTED, reason: 'Name mismatch' },
        ],
      ]),
    });
    expect(checklist.readyToSubmit).toBe(false);
    expect(checklist.items[3].review).toEqual({
      decision: 'rejected',
      reason: 'Name mismatch',
    });
  });
});
