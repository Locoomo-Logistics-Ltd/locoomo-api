import { MigrationInterface, QueryRunner } from 'typeorm';

// Merchant accounts, teams, onboarding/KYC and the review trail (plan M1).
// Enum-like columns are varchar + CHECK, not Postgres enums, so later
// phases add values without a separate ALTER TYPE migration.
export class CreateMerchants1786119888358 implements MigrationInterface {
  name = 'CreateMerchants1786119888358';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "type" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "tradingName" character varying(120) NOT NULL,
        "legalName" character varying(200),
        "category" character varying(60),
        "storeUrl" character varying(300),
        "expectedMonthlyVolume" character varying,
        "contactEmail" character varying(254),
        "contactPhone" character varying(20),
        "addressLine1" character varying(200),
        "addressLine2" character varying(200),
        "city" character varying(100),
        "state" character varying(60),
        "cacNumber" character varying(20),
        "tier" character varying,
        "limitOverrides" jsonb,
        "receiverCodeRelay" boolean NOT NULL DEFAULT false,
        "creationPaused" boolean NOT NULL DEFAULT false,
        "termsVersion" character varying(20),
        "termsAcceptedAt" TIMESTAMP WITH TIME ZONE,
        "termsAcceptedByUserId" uuid,
        "submittedAt" TIMESTAMP WITH TIME ZONE,
        "decidedAt" TIMESTAMP WITH TIME ZONE,
        "decidedByUserId" uuid,
        "decisionNote" character varying(1000),
        "approvedAt" TIMESTAMP WITH TIME ZONE,
        "suspendedAt" TIMESTAMP WITH TIME ZONE,
        "suspensionReason" character varying(1000),
        "statusBeforeSuspension" character varying,
        "closedAt" TIMESTAMP WITH TIME ZONE,
        "createdByUserId" uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchants" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_merchants_type" CHECK ("type" IN ('business', 'individual')),
        CONSTRAINT "CHK_merchants_status" CHECK ("status" IN ('draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'rejected', 'suspended', 'closed')),
        CONSTRAINT "CHK_merchants_tier" CHECK ("tier" IS NULL OR "tier" IN ('individual', 'business', 'enterprise')),
        CONSTRAINT "CHK_merchants_volume" CHECK ("expectedMonthlyVolume" IS NULL OR "expectedMonthlyVolume" IN ('up_to_100', 'up_to_1k', 'up_to_10k', 'up_to_100k', 'over_100k')),
        CONSTRAINT "FK_merchants_created_by" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchants_status_submitted" ON "merchants" ("status", "submittedAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_members" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "role" character varying NOT NULL,
        "invitedByUserId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_members" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_merchant_members_role" CHECK ("role" IN ('owner', 'admin', 'developer', 'operations', 'finance', 'viewer')),
        CONSTRAINT "FK_merchant_members_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_members_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
    // v1: one merchant per user. Drop this index to allow agencies later.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_merchant_members_user" ON "merchant_members" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_members_merchant" ON "merchant_members" ("merchantId")`,
    );
    // Exactly one owner: ownership transfer demotes before it promotes.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_merchant_members_one_owner" ON "merchant_members" ("merchantId") WHERE "role" = 'owner'`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_invites" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "email" character varying(254) NOT NULL,
        "role" character varying NOT NULL,
        "tokenHash" character varying NOT NULL,
        "invitedByUserId" uuid NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "acceptedAt" TIMESTAMP WITH TIME ZONE,
        "acceptedByUserId" uuid,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_invites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_invites_token" UNIQUE ("tokenHash"),
        CONSTRAINT "CHK_merchant_invites_role" CHECK ("role" IN ('admin', 'developer', 'operations', 'finance', 'viewer')),
        CONSTRAINT "FK_merchant_invites_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_merchant_invites_invited_by" FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE CASCADE
      )`,
    );
    // One open invite per address per merchant; re-inviting revokes the old one.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_merchant_invites_open" ON "merchant_invites" ("merchantId", "email") WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_directors" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "fullName" character varying(150) NOT NULL,
        "idType" character varying NOT NULL,
        "idNumberSealed" text NOT NULL,
        "idNumberLast4" character varying(4) NOT NULL,
        "idDocumentPublicId" character varying(255) NOT NULL,
        "createdByUserId" uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_directors" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_merchant_directors_id_type" CHECK ("idType" IN ('nin', 'passport', 'drivers_licence', 'voters_card')),
        CONSTRAINT "FK_merchant_directors_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_merchant_directors_merchant" ON "merchant_directors" ("merchantId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "kind" character varying NOT NULL,
        "publicId" character varying(255) NOT NULL,
        "uploadedByUserId" uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_documents" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_documents_kind" UNIQUE ("merchantId", "kind"),
        CONSTRAINT "CHK_merchant_documents_kind" CHECK ("kind" IN ('cac_certificate', 'cac_status_report', 'proof_of_address')),
        CONSTRAINT "FK_merchant_documents_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_bank_accounts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "merchantId" uuid NOT NULL,
        "bankCode" character varying(10) NOT NULL,
        "bankName" character varying(150) NOT NULL,
        "accountNumberSealed" text NOT NULL,
        "accountNumberLast4" character varying(4) NOT NULL,
        "accountName" character varying(200) NOT NULL,
        "nameMatchScore" numeric(4,3) NOT NULL,
        "verifiedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "setByUserId" uuid NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_merchant_bank_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_merchant_bank_accounts_merchant" UNIQUE ("merchantId"),
        CONSTRAINT "FK_merchant_bank_accounts_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );

    await queryRunner.query(
      `CREATE TABLE "merchant_review_items" (
        "merchantId" uuid NOT NULL,
        "key" character varying NOT NULL,
        "decision" character varying NOT NULL,
        "reason" character varying(500),
        "decidedByUserId" uuid NOT NULL,
        "decidedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_merchant_review_items" PRIMARY KEY ("merchantId", "key"),
        CONSTRAINT "CHK_merchant_review_items_key" CHECK ("key" IN ('profile', 'business_registration', 'directors', 'bank_account', 'terms')),
        CONSTRAINT "CHK_merchant_review_items_decision" CHECK ("decision" IN ('accepted', 'rejected')),
        -- The merchant is told why: a rejection always carries a reason.
        CONSTRAINT "CHK_merchant_review_items_reason" CHECK ("decision" = 'accepted' OR "reason" IS NOT NULL),
        CONSTRAINT "FK_merchant_review_items_merchant" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "merchant_review_items"`);
    await queryRunner.query(`DROP TABLE "merchant_bank_accounts"`);
    await queryRunner.query(`DROP TABLE "merchant_documents"`);
    await queryRunner.query(`DROP TABLE "merchant_directors"`);
    await queryRunner.query(`DROP TABLE "merchant_invites"`);
    await queryRunner.query(`DROP TABLE "merchant_members"`);
    await queryRunner.query(`DROP TABLE "merchants"`);
  }
}
