// Longer-lived than a password reset token (30 min) — verification is a
// lower-risk, lower-urgency action and users routinely don't open the email
// same-minute they register.
export const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = 24;
