// String values are the public contract (API responses, audit log, DB CHECK
// constraints in migration 1786119888358) — add values, never rename them.

export enum MerchantType {
  BUSINESS = 'business',
  INDIVIDUAL = 'individual',
}

export enum MerchantStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  IN_REVIEW = 'in_review',
  CHANGES_REQUESTED = 'changes_requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
  CLOSED = 'closed',
}

export enum MerchantTier {
  INDIVIDUAL = 'individual',
  BUSINESS = 'business',
  ENTERPRISE = 'enterprise',
}

export enum MerchantRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  DEVELOPER = 'developer',
  OPERATIONS = 'operations',
  FINANCE = 'finance',
  VIEWER = 'viewer',
}

// Rough monthly parcel volume, self-declared at onboarding. Buckets rather
// than a number: it's a sizing hint for the reviewer, not a commitment.
export enum ExpectedMonthlyVolume {
  UP_TO_100 = 'up_to_100',
  UP_TO_1K = 'up_to_1k',
  UP_TO_10K = 'up_to_10k',
  UP_TO_100K = 'up_to_100k',
  OVER_100K = 'over_100k',
}

export enum MerchantDocumentKind {
  // Business only, required: CAC certificate of incorporation / BN cert.
  CAC_CERTIFICATE = 'cac_certificate',
  // Optional supporting documents.
  CAC_STATUS_REPORT = 'cac_status_report',
  PROOF_OF_ADDRESS = 'proof_of_address',
}

export enum DirectorIdType {
  NIN = 'nin',
  PASSPORT = 'passport',
  DRIVERS_LICENCE = 'drivers_licence',
  VOTERS_CARD = 'voters_card',
}

// The sections of the onboarding checklist, each reviewed separately by
// the KYC admin (accept / reject with a reason).
export enum ReviewItemKey {
  PROFILE = 'profile',
  BUSINESS_REGISTRATION = 'business_registration',
  DIRECTORS = 'directors',
  BANK_ACCOUNT = 'bank_account',
  TERMS = 'terms',
}

export enum ReviewDecision {
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
}
