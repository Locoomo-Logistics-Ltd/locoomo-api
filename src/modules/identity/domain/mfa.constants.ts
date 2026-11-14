// How long a password- (or Google-) verified login waits for the 2FA code.
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
// Wrong codes allowed per login challenge before it's burned (the user
// must enter their password again).
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
// Days a user who must have 2FA (admins) can keep working without it.
export const MFA_ENROLLMENT_GRACE_DAYS = 14;
export const MFA_RECOVERY_CODE_COUNT = 10;
// Step-up window: defined in common/auth (merchants check it too).
export { REAUTH_VALID_SECONDS } from '../../../common/auth/recent-auth';
export const TOTP_ISSUER = 'Locoomo';
