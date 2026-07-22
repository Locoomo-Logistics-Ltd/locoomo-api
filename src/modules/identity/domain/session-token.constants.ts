// Short-lived — bounds the damage window if an access token leaks.
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

// Long-lived — rotated on every use (see refresh endpoint), so this is the
// outer bound on how long a session survives with zero activity.
export const REFRESH_TOKEN_TTL_DAYS = 30;
