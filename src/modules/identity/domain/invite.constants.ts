// Longer than a password reset link (30 min) or even email verification
// (24h) — an invited NodeOperator/Rider/Admin is provisioned by someone
// else and may not check that inbox same-day.
export const INVITE_TOKEN_TTL_DAYS = 7;
