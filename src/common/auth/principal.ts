import { UserRole } from './user-role.enum';

export type ApiKeyMode = 'test' | 'live';
export type ApiKeyKind = 'secret' | 'publishable';

// Who is calling. Cookie sessions resolve to `user`; merchant API keys
// (Authorization: Bearer sk_…/pk_…) resolve to `api_key`. An api_key
// principal deliberately never populates `request.user`, so every existing
// @Roles/@CurrentUser route rejects API keys without any change to them.
export interface UserPrincipal {
  kind: 'user';
  userId: string;
  role: UserRole;
}

export interface ApiKeyPrincipal {
  kind: 'api_key';
  keyId: string;
  keyKind: ApiKeyKind;
  merchantId: string;
  mode: ApiKeyMode;
  scopes: string[];
}

export type Principal = UserPrincipal | ApiKeyPrincipal;

// sk_live_…, sk_test_…, pk_live_…, pk_test_…
export const API_KEY_PATTERN = /^(sk|pk)_(test|live)_[A-Za-z0-9]{20,}$/;

export function looksLikeApiKey(token: string): boolean {
  return API_KEY_PATTERN.test(token);
}
