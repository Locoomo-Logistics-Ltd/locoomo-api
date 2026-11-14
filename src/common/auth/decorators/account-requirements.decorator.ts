import { SetMetadata } from '@nestjs/common';

export const REQUIRE_RECENT_AUTH_KEY = 'requireRecentAuth';
export const REQUIRE_VERIFIED_EMAIL_KEY = 'requireVerifiedEmail';
export const ALLOW_WITHOUT_MFA_ENROLLMENT_KEY = 'allowWithoutMfaEnrollment';

// Sensitive action (live keys, webhook URL, bank account, roles, closing
// an account): the session must have re-authenticated in the last few
// minutes (POST /auth/reauth), else 403 REAUTH_REQUIRED.
export const RequireRecentAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_RECENT_AUTH_KEY, true);

// Account must have a verified email (merchant routes), else
// 403 EMAIL_NOT_VERIFIED.
export const RequireVerifiedEmail = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_VERIFIED_EMAIL_KEY, true);

// Routes a user who *must* have 2FA but hasn't enrolled yet can still use
// after their grace period — the ones needed to enrol (2FA setup, profile,
// sign out). Everything else answers 403 MFA_ENROLLMENT_REQUIRED.
export const AllowWithoutMfaEnrollment = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WITHOUT_MFA_ENROLLMENT_KEY, true);
