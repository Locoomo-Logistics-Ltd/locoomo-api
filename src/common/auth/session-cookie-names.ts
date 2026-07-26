export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

// Refresh cookie is scoped so the browser only ever sends it to the one
// endpoint that consumes it — it never rides along on ordinary API calls.
export const REFRESH_TOKEN_COOKIE_PATH = '/api/v1/auth';
